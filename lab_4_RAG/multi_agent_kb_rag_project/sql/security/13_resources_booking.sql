-- 13_resources_booking.sql
-- Municipal resource booking slots (arnona appointments, etc.)
-- Depends on: 07_users.sql

CREATE TABLE IF NOT EXISTS resources_booking (
  id                  BIGSERIAL    PRIMARY KEY,
  resource_key        TEXT         NOT NULL,
  resource_name       TEXT         NOT NULL,
  slot_start          TIMESTAMPTZ  NOT NULL,
  slot_end            TIMESTAMPTZ  NOT NULL,
  status              TEXT         NOT NULL DEFAULT 'available'
                                   CHECK (status IN ('available', 'reserved', 'booked', 'cancelled')),
  booked_by_user_id   BIGINT       REFERENCES users (id) ON DELETE SET NULL,
  booking_reference   TEXT,
  notes               TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (resource_key, slot_start, slot_end)
);

CREATE INDEX IF NOT EXISTS idx_resources_booking_slot_start
  ON resources_booking (slot_start);

CREATE INDEX IF NOT EXISTS idx_resources_booking_status_slot
  ON resources_booking (status, slot_start);
