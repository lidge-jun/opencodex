/** A link-mode Child's saved tunnel: the local port its link reaches the Home through. */
export interface OcxLinkTransportConfig {
  tunnelPort: number;
  linkId: string;
}

/** Home-side Remote Link settings. */
export interface OcxLinkHomeConfig {
  /**
   * Whether this Home tells its Children it accepts per-body zstd request bodies (#3023). Absent or
   * true: it does, and a Child compresses bodies above 1 KiB. False: it stops naming the capability,
   * and its Children send identity bodies exactly as before it existed. Read at proxy start.
   *
   * Compression lets someone who can both put chosen text into a request body beside a secret and
   * see the sizes of many such requests guess the secret from how well each one compresses. On a
   * link that is whoever sees its traffic: a relay operator or anyone on the network path, because
   * the tunnel hides content but not sizes.
   */
  linkRequestCompression?: boolean;
}
