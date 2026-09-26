import SwiftUI

/// What the panel sends the host for a "Use" click: the provider id and the provider's own
/// account id, never the row's display key. `nil` when the row is not switchable.
public enum NativeTraySwitch {
    public static func request(provider: NativeTrayProvider, account: NativeTrayProvider.Account) -> (provider: String, accountId: String)? {
        guard provider.switchable == true, account.canSwitch, let accountId = account.accountId else { return nil }
        return (provider.id, accountId)
    }
}

/// An account row's first line: label, plan, the active check, and the "Use" action.
///
/// Use is revealed on hover or when keyboard focus reaches it, and is always offered as an
/// accessibility action; it keeps its space while hidden so revealing it never moves the row. The
/// rules come from the host's snapshot, which mirrors the runtime: only a hard-locked main account
/// or a paused account is blocked, and an exhausted account stays switchable with a warning.
struct NativeTrayAccountHeader: View {
    let account: NativeTrayProvider.Account
    let switchable: Bool
    let pending: Bool
    let busy: Bool
    let onUse: () -> Void
    @State private var hovered = false
    @FocusState private var focused: Bool

    private var offersUse: Bool { switchable && account.canSwitch }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(account.label).lineLimit(1).help(account.label)
                if account.exhausted == true {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        .imageScale(.small)
                        .help("A limit window is used up; requests may fail until it resets")
                        .accessibilityLabel("Limit reached")
                }
                Spacer(minLength: 6)
                if pending {
                    ProgressView().controlSize(.mini).accessibilityLabel("Switching account")
                } else if offersUse {
                    Button("Use", action: onUse)
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                        .disabled(busy)
                        .focused($focused)
                        .opacity(hovered || focused ? 1 : 0)
                        .help("Make this the active account")
                        .accessibilityLabel("Use \(account.label)")
                }
                if let plan = account.plan { Text(plan).foregroundStyle(.secondary) }
                if account.active {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        .accessibilityLabel("Active account").help("Active account")
                }
            }
            .font(.caption)
            if account.switchState == "blocked" {
                Text(account.blockedReason == "mainHardLock" ? "Blocked by 98% protection" : "Paused")
                    .font(.caption2).foregroundStyle(.orange)
            }
        }
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityActions {
            if offersUse && !busy { Button("Use this account", action: onUse) }
        }
    }
}
