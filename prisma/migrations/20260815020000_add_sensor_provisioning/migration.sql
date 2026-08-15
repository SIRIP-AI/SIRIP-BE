CREATE TYPE "SensorProvisioningStatus" AS ENUM ('PENDING', 'PROVISIONED');

ALTER TABLE "sensors" ADD COLUMN "provisioning_status" "SensorProvisioningStatus" NOT NULL DEFAULT 'PENDING';
