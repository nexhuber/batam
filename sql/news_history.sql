-- Run in BQ_PROJECT with the job location matching the news dataset.
-- Create the news dataset first if it does not already exist.
CREATE TABLE IF NOT EXISTS `news.news_history` (
  id STRING NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  is_hide BOOL DEFAULT FALSE NOT NULL,
  content STRING NOT NULL,
  news_type STRING NOT NULL,
  period_key STRING NOT NULL
)
PARTITION BY DATE(created_at)
CLUSTER BY news_type, period_key;
