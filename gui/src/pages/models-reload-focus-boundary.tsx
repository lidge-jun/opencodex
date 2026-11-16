import { Component, type ReactNode, type RefObject } from "react";

type Props = {
  stale: boolean;
  headRef: RefObject<HTMLButtonElement | null>;
  bannerRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
};

/** Snapshot focus immediately before React replaces the action, not when a read resolves. */
export class ModelsReloadFocusBoundary extends Component<Props, object, HTMLButtonElement | null> {
  getSnapshotBeforeUpdate(previous: Props): HTMLButtonElement | null {
    if (previous.stale === this.props.stale) return null;
    const outgoing = previous.stale ? previous.bannerRef.current : previous.headRef.current;
    return outgoing?.ownerDocument.activeElement === outgoing ? outgoing : null;
  }

  componentDidUpdate(_previous: Props, _state: object, outgoing: HTMLButtonElement | null) {
    if (!outgoing) return;
    const active = outgoing.ownerDocument.activeElement;
    // A synchronous focus move during the commit belongs to the user or another control.
    if (active !== outgoing && active !== outgoing.ownerDocument.body) return;
    const target = this.props.stale ? this.props.bannerRef.current : this.props.headRef.current;
    if (target && !target.disabled) target.focus();
  }

  render() { return this.props.children; }
}
