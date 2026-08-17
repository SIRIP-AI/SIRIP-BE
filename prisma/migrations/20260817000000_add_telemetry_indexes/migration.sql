CREATE INDEX "sensor_sessions_sensor_id_status_idx" ON "sensor_sessions"("sensor_id", "status");
CREATE INDEX "temperature_readings_sensor_session_id_measured_at_idx" ON "temperature_readings"("sensor_session_id", "measured_at");
