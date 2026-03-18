ALTER TABLE approval_queue
  ALTER COLUMN telegram_message_id TYPE BIGINT USING telegram_message_id::BIGINT;

DROP INDEX IF EXISTS idx_approval_queue_candidate_type_status;

CREATE INDEX IF NOT EXISTS idx_approval_queue_candidate_type_status
  ON approval_queue(candidate_id, message_type, status, created_at);
