#ifdef _WIN32
typedef int BOOL;
typedef unsigned long DWORD;
typedef unsigned short WCHAR;

BOOL MoveFileW(const WCHAR *source, const WCHAR *destination);
DWORD GetLastError(void);

int ocx_rename_noreplace(const WCHAR *source, const WCHAR *destination) {
  if (MoveFileW(source, destination)) return 0;
  return (int)GetLastError();
}
#elif defined(__linux__)
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif

int ocx_rename_noreplace(const char *source, const char *destination) {
#ifdef SYS_renameat2
  if (syscall(SYS_renameat2, AT_FDCWD, source, AT_FDCWD, destination, RENAME_NOREPLACE) == 0) return 0;
  return errno;
#else
  return ENOTSUP;
#endif
}
#elif defined(__APPLE__)
#include <errno.h>
#include <stdio.h>

#ifndef RENAME_EXCL
#define RENAME_EXCL 0x00000004
#endif

int ocx_rename_noreplace(const char *source, const char *destination) {
  if (renamex_np(source, destination, RENAME_EXCL) == 0) return 0;
  return errno;
}
#else
#include <errno.h>

int ocx_rename_noreplace(const char *source, const char *destination) {
  (void)source;
  (void)destination;
  return ENOTSUP;
}
#endif
