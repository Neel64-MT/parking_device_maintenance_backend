-- Replace unused ticket status "New" with "Open".
UPDATE tickets SET status = 'Open' WHERE status = 'New';
