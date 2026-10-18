namespace mdu.ui.telemetry.events
{
    /// <summary>
    /// Destination for collected telemetry events. Implementations decide where
    /// events go (file today, InfluxDB HTTP later) — collection code never
    /// changes when the transport does.
    /// </summary>
    public interface ITelemetryEventSink
    {
        /// <summary> Accepts one event (may buffer). </summary>
        void write(TelemetryEvent e);

        /// <summary> Writes everything currently buffered to the underlying destination. </summary>
        void flush();

        /// <summary> Flushes and releases any resources. </summary>
        void dispose();
    }
}
