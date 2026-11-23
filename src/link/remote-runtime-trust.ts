/**
 * POSIX census targets are hints, not execution authority. Walk each path before its
 * first version probe, including symlink destinations and directory replacement
 * authority. Only root and the SSH account may control traversed components; the
 * final regular file must belong to the SSH account and have no foreign write bit.
 * Sticky shared directories are safe only with the same ownership checks on their
 * children. Keep the verified original spelling so package-prefix discovery and
 * interpreter entrypoint semantics remain unchanged.
 * macOS recorded hints are skipped: mode bits miss ACL grants and system ls can
 * conceal ACL read failures. Its existing known-install discovery still runs.
 * These checks do not defend against root or unrestricted same-account mutation.
 */
export const REMOTE_SERVED_PATH_TRUST = `served_path_info() {
  stat -c '%u %a' "$1" 2>/dev/null || stat -f '%u %Mp%03Lp' "$1" 2>/dev/null
}
trusted_served_path() (
  case "$1" in /*) ;; *) return 1;; esac
  # A portable shell cannot prove macOS ACL protection from stat/ls output.
  [ "$(uname -s 2>/dev/null)" = Linux ] || return 1
  served_uid=$(id -u 2>/dev/null) || return 1
  case "$served_uid" in ''|*[!0-9]*) return 1;; esac
  original=$1; pending=\${1#/}; resolved=/; steps=0; links=0
  # The root is trusted only after the same ownership/mode validation as each directory.
  component=/
  while :; do
    steps=$((steps + 1)); [ "$steps" -le 512 ] || return 1
    info=$(served_path_info "$component") || return 1
    case "$info" in ''|*[!0-9[:blank:]]*) return 1;; esac
    set -- $info
    [ "$#" -eq 2 ] || return 1
    case "$2" in ''|*[!0-7]*) return 1;; esac
    [ "\${#2}" -le 4 ] || return 1
    [ "$1" = "$served_uid" ] || [ "$1" = 0 ] || return 1
    if [ -L "$component" ]; then
      links=$((links + 1)); [ "$links" -le 40 ] || return 1
      # Preserve trailing newlines in a link target instead of validating a different path.
      target=$(readlink "$component" 2>/dev/null && printf '.') || return 1
      target=\${target%.}
      case "$target" in *'
') target=\${target%?};; *) return 1;; esac
      case "$target" in ''|*'
'*) return 1;; esac
      [ -z "$pending" ] || target=$target/$pending
      case "$target" in /*) resolved=/; pending=\${target#/};; *) pending=$target;; esac
    elif [ -d "$component" ]; then
      # Group/world write is allowed only on a trusted sticky directory. Its next
      # entry must still be root/account-owned, so another account cannot replace it.
      [ $((0$2 & 0022)) -eq 0 ] || [ $((0$2 & 01000)) -ne 0 ] || return 1
      resolved=$component
    else
      [ -z "$pending" ] && [ -f "$component" ] || return 1
      [ "$1" = "$served_uid" ] && [ $((0$2 & 0022)) -eq 0 ] || return 1
      printf '%s\\n' "$original"
      return 0
    fi
    while :; do
      [ -n "$pending" ] || return 1
      name=\${pending%%/*}
      case "$pending" in */*) pending=\${pending#*/};; *) pending=;; esac
      case "$name" in
        ''|.) continue;;
        ..) resolved=\${resolved%/*}; [ -n "$resolved" ] || resolved=/; continue;;
      esac
      component=\${resolved%/}/$name
      break
    done
  done
)
`;
