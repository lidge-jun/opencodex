export function AddProviderField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block" }}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
