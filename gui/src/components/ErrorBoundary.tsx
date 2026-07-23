import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  pageName: string;
  title: string;
  message: string;
  detailsLabel: string;
  reloadLabel: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }

  private reload = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <section
        className="card"
        role="alert"
        style={{ maxWidth: 720, padding: "var(--space-6)" }}
      >
        <h2 style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-title)" }}>
          {this.props.pageName}: {this.props.title}
        </h2>
        <p className="muted" style={{ margin: "0 0 var(--space-4)" }}>
          {this.props.message}
        </p>
        <p style={{ margin: "0 0 var(--space-5)", overflowWrap: "anywhere" }}>
          <strong>{this.props.detailsLabel}:</strong> {this.state.error.message}
        </p>
        <button type="button" className="btn btn-primary" onClick={this.reload}>
          {this.props.reloadLabel}
        </button>
      </section>
    );
  }
}
