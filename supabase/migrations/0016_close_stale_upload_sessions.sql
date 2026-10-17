-- One-off cleanup: kDrive cancels upload sessions after 4 hours, so any session
-- left 'open' before this release holds a dead token and must not be resumed.
UPDATE upload_sessions
SET status = 'closed', updated_at = now()
WHERE status = 'open';
