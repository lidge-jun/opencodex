interface QuickActionsProps {
  onOpenDashboard: () => void;
}

export function QuickActions({ onOpenDashboard }: QuickActionsProps) {
  return (
    <div className="quick-actions">
      <button className="btn btn-primary" onClick={onOpenDashboard}>
        Open Dashboard
      </button>
    </div>
  );
}
