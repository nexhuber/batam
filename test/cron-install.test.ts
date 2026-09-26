import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = process.cwd();
let root: string;
let env: NodeJS.ProcessEnv;
function executable(name: string, content: string) {
  const path = join(root, "bin", name);
  writeFileSync(path, `#!/bin/bash\n${content}\n`);
  chmodSync(path, 0o755);
}
function install(timezone = "UTC", release = repo) {
  return spawnSync("/bin/bash", ["-c", 'source "$1/deploy/cron.sh"; batam_cron_timezone() { printf "%s\\n" "$TEST_TIMEZONE"; }; batam_setup_cron "$2" "$3" 3105 "$4"', "test", repo, root, join(root, "env"), release], {
    encoding: "utf8", env: { ...env, TEST_TIMEZONE: timezone },
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "batam cron-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "env"), "CRON_SECRET=test-secret\nLARK_WEBHOOK_URL=https://example.invalid\n");
  env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, TEST_CRONTAB: join(root, "crontab") };
  executable("id", 'echo 0');
  executable("systemctl", 'exit 0');
  executable("crontab", 'if [[ $1 == -l ]]; then\n  if [[ -f $TEST_CRONTAB ]]; then cat "$TEST_CRONTAB"; else echo "no crontab for root" >&2; exit 1; fi\nelse cp "$1" "$TEST_CRONTAB"; fi');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Linux cron installation with fake OS commands", () => {
  it("installs twice without duplication and preserves unrelated entries", () => {
    writeFileSync(join(root, "crontab"), "# another job\n0 4 * * * /bin/true\n");
    expect(install().status).toBe(0);
    const first = readFileSync(join(root, "crontab"), "utf8");
    expect(install().status).toBe(0);
    expect(readFileSync(join(root, "crontab"), "utf8")).toBe(first);
    expect(first).toContain("0 4 * * * /bin/true");
    expect(first).toContain("0 1 * * 1 ");
    expect(first.match(/weekly-brand-inventory/g)).toHaveLength(1);
    expect(first).not.toContain("test-secret");
  });
  it("uses 08:00 on a Vietnam daemon and updates an existing UTC entry", () => {
    expect(install().status).toBe(0);
    expect(install("Asia/Ho_Chi_Minh").status).toBe(0);
    const text = readFileSync(join(root, "crontab"), "utf8");
    expect(text).toContain("0 8 * * 1 ");
    expect(text).not.toContain("0 1 * * 1 ");
  });
  it("rejects unsupported timezone without changing the old crontab", () => {
    writeFileSync(join(root, "crontab"), "# keep me\n");
    expect(install("Europe/London").status).not.toBe(0);
    expect(readFileSync(join(root, "crontab"), "utf8")).toBe("# keep me\n");
  });
  it("removes the managed block on rollback to a release without cron", () => {
    writeFileSync(join(root, "crontab"), "# keep me\n");
    expect(install().status).toBe(0);
    const oldRelease = join(root, "old-release");
    mkdirSync(oldRelease);
    expect(install("UTC", oldRelease).status).toBe(0);
    expect(readFileSync(join(root, "crontab"), "utf8")).toBe("# keep me\n");
  });
  it("uses the original physical installer after current switches to a pre-cron release", () => {
    expect(install().status).toBe(0);
    const latest = join(root, "latest");
    const older = join(root, "older");
    mkdirSync(join(latest, "deploy"), { recursive: true });
    mkdirSync(older);
    // Load the actual deploy functions without dispatching a deployment.
    const source = readFileSync(join(repo, "deploy/deploy.sh"), "utf8");
    writeFileSync(join(latest, "deploy/deploy.sh"), source.slice(0, source.lastIndexOf("\nvalidate_config\ncase")));
    writeFileSync(join(latest, "deploy/cron.sh"), readFileSync(join(repo, "deploy/cron.sh")));
    symlinkSync(latest, join(root, "current"));
    executable("uname", "echo Linux");
    const result = spawnSync("/bin/bash", ["-c", 'source "$1/current/deploy/deploy.sh"; rm "$1/current"; ln -s "$1/older" "$1/current"; setup_cron "$1/older"', "test", root], {
      encoding: "utf8", env: { ...env, BATAM_APP_DIR: root, BATAM_ENV_FILE: join(root, "env"), BATAM_PM: "systemd" },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "crontab"), "utf8")).not.toContain("BATAM CRON");
  });
  it("refuses a malformed managed block", () => {
    const broken = "# BEGIN BATAM CRON\n0 1 * * 1 old-command\n";
    writeFileSync(join(root, "crontab"), broken);
    expect(install().status).not.toBe(0);
    expect(readFileSync(join(root, "crontab"), "utf8")).toBe(broken);
  });
  it("does not overwrite crontab on read failures", () => {
    executable("crontab", 'echo "permission denied" >&2; exit 1');
    expect(install().status).not.toBe(0);
    expect(existsSync(join(root, "crontab"))).toBe(false);
  });
  it("does not install without webhook credentials", () => {
    writeFileSync(join(root, "env"), "CRON_SECRET=test-secret\n");
    expect(install().status).not.toBe(0);
    expect(existsSync(join(root, "crontab"))).toBe(false);
  });
  it("rejects a pre-existing CRON_TZ override without changing other jobs", () => {
    const previous = "CRON_TZ=Europe/London\n0 4 * * * /bin/true\n";
    writeFileSync(join(root, "crontab"), previous);
    expect(install().status).not.toBe(0);
    expect(readFileSync(join(root, "crontab"), "utf8")).toBe(previous);
  });
  it("passes auth over stdin to curl exactly once, and reports failures", () => {
    executable("curl", 'cat > "$TEST_AUTH"; printf "%s\\n" "$@" > "$TEST_ARGS"; echo "test response"; exit 22');
    const result = spawnSync("/bin/bash", [resolve("deploy/run-cron.sh"), root, join(root, "env"), "3105", "weekly-brand-inventory"], {
      env: { ...env, TEST_AUTH: join(root, "auth"), TEST_ARGS: join(root, "args") }, encoding: "utf8",
    });
    expect(result.status).toBe(22);
    expect(readFileSync(join(root, "auth"), "utf8")).toBe("Authorization: Bearer test-secret\n");
    const args = readFileSync(join(root, "args"), "utf8");
    expect(args).toContain("http://127.0.0.1:3105/api/cron/weekly-brand-inventory");
    expect(args).not.toContain("test-secret");
    expect(args).not.toContain("--retry");
    expect(readFileSync(join(root, ".cron.log"), "utf8")).toContain("Failed weekly-brand-inventory");
  });
  it("has valid shell syntax", () => {
    for (const script of ["deploy/deploy.sh", "deploy/cron.sh", "deploy/run-cron.sh"]) {
      expect(() => execFileSync("/bin/bash", ["-n", script])).not.toThrow();
    }
  });
});
