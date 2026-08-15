CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "FishingTripStatus" AS ENUM ('ACTIVE', 'COMPLETED');

CREATE TYPE "BatchStatus" AS ENUM ('MONITORING', 'ACTIVE', 'INSPECTION_HOLD', 'HANDED_OVER', 'CLOSED');

CREATE TYPE "SensorStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'OFFLINE', 'ERROR');

CREATE TYPE "SensorSessionStatus" AS ENUM ('ACTIVE', 'COMPLETED');

CREATE TYPE "ColdStorageStatus" AS ENUM ('AVAILABLE', 'FULL', 'UNAVAILABLE');

CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'ASSIGNED', 'DELAYED', 'UNAVAILABLE');

CREATE TYPE "DestinationStatus" AS ENUM ('AVAILABLE', 'UNAVAILABLE');

CREATE TYPE "OperationalEventType" AS ENUM ('TEMPERATURE_EXCURSION', 'TRUCK_DELAY', 'STORAGE_CHANGE', 'DESTINATION_CHANGE', 'INSPECTION_HOLD', 'OTHER');

CREATE TYPE "OperationalEventSource" AS ENUM ('SYSTEM', 'WEB', 'WHATSAPP');

CREATE TYPE "PlanStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'SUPERSEDED', 'DISMISSED');

CREATE TYPE "PlanActionType" AS ENUM ('STORE', 'LOAD', 'DISPATCH', 'HANDOVER', 'INSPECT', 'OTHER');

CREATE TYPE "PlanStepStatus" AS ENUM ('UPCOMING', 'COMPLETED', 'CANCELED');

CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fishing_trips" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "vessel_name" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "status" "FishingTripStatus" NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fishing_trips_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "batches" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "fishing_trip_id" BIGINT,
    "weight_kg" DOUBLE PRECISION NOT NULL,
    "grade" TEXT NOT NULL,
    "status" "BatchStatus" NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL,
    "handed_over_at" TIMESTAMPTZ,
    "equivalent_quality_age_days" DOUBLE PRECISION,
    "remaining_quality_window_days" DOUBLE PRECISION,
    "quality_estimate_started_at" TIMESTAMPTZ,
    "current_temperature_c" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sensors" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "device_uid" TEXT NOT NULL,
    "status" "SensorStatus" NOT NULL,
    "last_seen_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sensors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sensor_sessions" (
    "id" BIGSERIAL NOT NULL,
    "sensor_id" BIGINT NOT NULL,
    "batch_id" BIGINT NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL,
    "ended_at" TIMESTAMPTZ,
    "status" "SensorSessionStatus" NOT NULL,
    "last_synced_at" TIMESTAMPTZ,

    CONSTRAINT "sensor_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "temperature_readings" (
    "id" BIGSERIAL NOT NULL,
    "sensor_session_id" BIGINT NOT NULL,
    "temperature_c" DOUBLE PRECISION NOT NULL,
    "measured_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL,
    "reading_uid" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "temperature_readings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cold_storages" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "capacity_kg" DOUBLE PRECISION NOT NULL,
    "available_capacity_kg" DOUBLE PRECISION NOT NULL,
    "status" "ColdStorageStatus" NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "cold_storages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "vehicles" (
    "id" BIGSERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "capacity_kg" DOUBLE PRECISION NOT NULL,
    "status" "VehicleStatus" NOT NULL,
    "delay_minutes" INTEGER NOT NULL DEFAULT 0,
    "available_from" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "destinations" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "travel_minutes" INTEGER NOT NULL,
    "receiving_start" TIME NOT NULL,
    "receiving_end" TIME NOT NULL,
    "status" "DestinationStatus" NOT NULL,
    "notes" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "destinations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operational_events" (
    "id" BIGSERIAL NOT NULL,
    "type" "OperationalEventType" NOT NULL,
    "source" "OperationalEventSource" NOT NULL,
    "batch_id" BIGINT,
    "vehicle_id" BIGINT,
    "cold_storage_id" BIGINT,
    "destination_id" BIGINT,
    "raw_message" TEXT,
    "structured_data" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operational_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "plans" (
    "id" BIGSERIAL NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PlanStatus" NOT NULL,
    "previous_plan_id" BIGINT,
    "trigger_event_id" BIGINT,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ,
    "approved_by" BIGINT,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "plan_steps" (
    "id" BIGSERIAL NOT NULL,
    "plan_id" BIGINT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "action_type" "PlanActionType" NOT NULL,
    "batch_id" BIGINT NOT NULL,
    "cold_storage_id" BIGINT,
    "vehicle_id" BIGINT,
    "destination_id" BIGINT,
    "scheduled_at" TIMESTAMPTZ NOT NULL,
    "status" "PlanStepStatus" NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "notes" TEXT,

    CONSTRAINT "plan_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

CREATE UNIQUE INDEX "fishing_trips_code_key" ON "fishing_trips"("code");

CREATE UNIQUE INDEX "batches_code_key" ON "batches"("code");

CREATE UNIQUE INDEX "sensors_code_key" ON "sensors"("code");

CREATE UNIQUE INDEX "sensors_device_uid_key" ON "sensors"("device_uid");

CREATE UNIQUE INDEX "temperature_readings_reading_uid_key" ON "temperature_readings"("reading_uid");

CREATE UNIQUE INDEX "cold_storages_name_key" ON "cold_storages"("name");

CREATE UNIQUE INDEX "vehicles_code_key" ON "vehicles"("code");

CREATE UNIQUE INDEX "destinations_name_key" ON "destinations"("name");

CREATE UNIQUE INDEX "plans_version_key" ON "plans"("version");

CREATE UNIQUE INDEX "plan_steps_plan_id_sequence_key" ON "plan_steps"("plan_id", "sequence");

ALTER TABLE "batches" ADD CONSTRAINT "batches_fishing_trip_id_fkey" FOREIGN KEY ("fishing_trip_id") REFERENCES "fishing_trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sensor_sessions" ADD CONSTRAINT "sensor_sessions_sensor_id_fkey" FOREIGN KEY ("sensor_id") REFERENCES "sensors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sensor_sessions" ADD CONSTRAINT "sensor_sessions_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "temperature_readings" ADD CONSTRAINT "temperature_readings_sensor_session_id_fkey" FOREIGN KEY ("sensor_session_id") REFERENCES "sensor_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_cold_storage_id_fkey" FOREIGN KEY ("cold_storage_id") REFERENCES "cold_storages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "plans" ADD CONSTRAINT "plans_previous_plan_id_fkey" FOREIGN KEY ("previous_plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "plans" ADD CONSTRAINT "plans_trigger_event_id_fkey" FOREIGN KEY ("trigger_event_id") REFERENCES "operational_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "plans" ADD CONSTRAINT "plans_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_cold_storage_id_fkey" FOREIGN KEY ("cold_storage_id") REFERENCES "cold_storages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_destination_id_fkey" FOREIGN KEY ("destination_id") REFERENCES "destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "batches" ADD CONSTRAINT "batches_weight_kg_check" CHECK ("weight_kg" > 0);
ALTER TABLE "cold_storages" ADD CONSTRAINT "cold_storages_capacity_kg_check" CHECK ("capacity_kg" > 0);
ALTER TABLE "cold_storages" ADD CONSTRAINT "cold_storages_available_capacity_kg_check" CHECK ("available_capacity_kg" >= 0 AND "available_capacity_kg" <= "capacity_kg");
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_capacity_kg_check" CHECK ("capacity_kg" > 0);
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_delay_minutes_check" CHECK ("delay_minutes" >= 0);
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_travel_minutes_check" CHECK ("travel_minutes" >= 0);
ALTER TABLE "plans" ADD CONSTRAINT "plans_version_check" CHECK ("version" > 0);
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_sequence_check" CHECK ("sequence" > 0);

CREATE UNIQUE INDEX "one_active_session_per_sensor" ON "sensor_sessions"("sensor_id") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "one_active_session_per_batch" ON "sensor_sessions"("batch_id") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "one_active_plan" ON "plans"("status") WHERE "status" = 'ACTIVE';

CREATE FUNCTION prevent_completed_plan_step_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'COMPLETED' THEN
    RAISE EXCEPTION 'completed plan steps are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "completed_plan_steps_are_immutable"
BEFORE UPDATE ON "plan_steps"
FOR EACH ROW EXECUTE FUNCTION prevent_completed_plan_step_update();
