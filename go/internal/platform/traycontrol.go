//go:build windows

package platform

import (
	"context"
	"fmt"

	"github.com/lidge-jun/opencodex-go/internal/tray"
)

type TrayAction string

const (
	TrayStatus    TrayAction = "status"
	TrayInstall   TrayAction = "install"
	TrayUninstall TrayAction = "uninstall"
)

func RunTrayAction(ctx context.Context, manager tray.Manager, action TrayAction) (tray.Status, error) {
	switch action {
	case TrayStatus:
		return manager.Status(ctx)
	case TrayInstall:
		return manager.Install(ctx, true)
	case TrayUninstall:
		return manager.Uninstall(ctx)
	default:
		return tray.Status{}, fmt.Errorf("unknown tray action %q", action)
	}
}
