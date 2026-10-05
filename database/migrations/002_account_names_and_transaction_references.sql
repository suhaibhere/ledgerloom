ALTER TABLE users RENAME COLUMN display_name TO name;
ALTER TABLE transactions RENAME COLUMN date TO transaction_date;
ALTER TABLE transactions ADD COLUMN transaction_reference TEXT;
