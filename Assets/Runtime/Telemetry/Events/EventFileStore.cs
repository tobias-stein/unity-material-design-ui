using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using UnityEngine;

namespace mdu.ui.telemetry.events
{
    /// <summary>
    /// Shared directory/retention helpers for event files (archive and pending
    /// alike), so every sink resolves the same location and prunes the same way.
    /// </summary>
    public static class EventFileStore
    {
        /// <summary> Active directory event files are written to (per Telemetry.config). </summary>
        public static string resolveDirectory()
        {
            var config = Telemetry.config;
            var baseDir = config.outputLocation == TelemetryOutputLocation.Custom
                          && !string.IsNullOrWhiteSpace(config.customOutputPath)
                ? config.customOutputPath
                : Application.persistentDataPath;

            return string.IsNullOrWhiteSpace(config.eventsSubfolder)
                ? baseDir
                : Path.Combine(baseDir, config.eventsSubfolder);
        }

        /// <summary> Deletes oldest event files beyond the configured count (0 = unlimited). </summary>
        public static void prune(string directory)
        {
            var maxFiles = Telemetry.config.eventsMaxFiles;
            if (maxFiles <= 0 || string.IsNullOrEmpty(directory))
            {
                return;
            }

            FileInfo[] files;
            try
            {
                files = new DirectoryInfo(directory).GetFiles("*.lp");
            }
            catch (Exception ex)
            {
                Debug.LogException(ex);
                return;
            }

            if (files.Length <= maxFiles)
            {
                return;
            }

            Array.Sort(files, (a, b) => a.LastWriteTimeUtc.CompareTo(b.LastWriteTimeUtc)); // oldest first
            for (var i = 0; i < files.Length - maxFiles; i++)
            {
                try
                {
                    File.Delete(files[i].FullName);
                }
                catch (Exception ex)
                {
                    Debug.LogException(ex);
                    return;
                }
            }
        }

        public static string sanitize(string value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return value;
            }

            var invalid = Path.GetInvalidFileNameChars();
            var builder = new StringBuilder(value.Length);
            foreach (var c in value)
            {
                builder.Append(Array.IndexOf(invalid, c) >= 0 ? '_' : c);
            }
            return builder.ToString();
        }
    }
}
