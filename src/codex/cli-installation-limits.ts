/**
 * Shared finite observation bound, independent of platform/native API modules.
 * Published npm backings exceed 256 MiB: Linux 0.163.0 is 296,865,480 bytes
 * and Windows 0.153.4 is 295,408,944 bytes. Both readers hash native files in
 * bounded chunks; 1 GiB limits read time without allocating the whole file.
 */
export const MAX_NATIVE_BACKING_BYTES = 1024 * 1024 * 1024;
