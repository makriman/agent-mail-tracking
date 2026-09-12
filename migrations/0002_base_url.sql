-- Persist the tracking origin used at create time so GET /v1/messages/:id
-- does not rewrite pixel_url / tracked_url to the current request Host.

ALTER TABLE messages ADD COLUMN base_url TEXT;
