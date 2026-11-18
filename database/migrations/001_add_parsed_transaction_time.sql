-- Idempotent MySQL 8.0+ Migration: add parsed_transaction_time to notification_events
USE takaledger_gateway;

SET @col_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'notification_events'
    AND COLUMN_NAME = 'parsed_transaction_time'
);

SET @ddl = IF(
  @col_exists = 0,
  'ALTER TABLE notification_events ADD COLUMN parsed_transaction_time VARCHAR(64) NULL AFTER parsed_bank_name',
  'SELECT "Column parsed_transaction_time already exists" AS status'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
