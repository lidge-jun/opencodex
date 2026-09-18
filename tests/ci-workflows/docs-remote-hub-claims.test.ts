/**
 * The remote hub guide has to stay runnable end to end on a FRESH standalone config.
 *
 * It did not (#4200). The setup block told the reader to run a nested `ocx config set hub.<field>`
 * immediately after `ocx config set runtimeRole hub`, but `runtimeRole` does not create the object
 * and the CLI refuses to create a missing parent, so the guide's own next line died with
 * `config parent path not found: hub`. A guide that cannot be followed verbatim is worse than a
 * missing one: the reader assumes they broke something.
 *
 * The second half is the data plane. The management ingress deliberately serves no `/v1/*`,
 * `/healthz` or `/readyz`, so publishing only that ingress through Tailscale Serve leaves a hub
 * that pairs and then cannot answer a request. The trap is quiet, because a loopback-bound data
 * listener still returns 200 from `/readyz` while answering 403 on `/v1/catalog`.
 *
 * These assertions are cheap and the guide is edited often, which is the whole reason the first
 * defect survived to a public URL.
 *
 * The third group (#4236) pins the one-port recipe. The manual
 * `export OPENCODEX_API_AUTH_TOKEN=…` step is the one that has to stay gone: it is how the
 * maintainer's hub ended up with a management admin token in the data-plane variable, and the
 * service now provisions its own token, so re-adding the line would re-teach the incident.
 *
 * Round one fixed the English source only, and the seven translated copies kept telling their
 * readers to run the line that fails (#4200). That drift was unenforced because this oracle read
 * one file. The locale-wide block below is the part that keeps the next English edit from
 * silently leaving the translations behind; the markers it pins are commands and literal error
 * codes, which survive translation, rather than prose a translator is supposed to rewrite.
 */
import { describe, expect, test } from "bun:test";
import { repoPath } from "../helpers/repo-root";

const GUIDE = repoPath("docs-site/src/content/docs/guides/remote-hub.md");
const KO_GUIDE = repoPath("docs-site/src/content/docs/ko/guides/remote-hub.md");
const TRANSLATED = ["ko", "ja", "zh-cn", "zh-tw", "fr", "ru", "tr"] as const;
const LOCALE_GUIDES: ReadonlyArray<readonly [string, string]> = [
  ["en", GUIDE],
  ...TRANSLATED.map(locale => [locale, repoPath(`docs-site/src/content/docs/${locale}/guides/remote-hub.md`)] as const),
];

describe("remote hub guide", () => {
  test("no nested config set runs before its parent object exists", async () => {
    const source = await Bun.file(GUIDE).text();

    // The ordering IS the fix. Asserting only that the initializer appears somewhere would pass on
    // a guide that still sets the field first and mentions `{}` afterwards.
    for (const parent of ["hub", "remoteGui"] as const) {
      const initializer = source.indexOf(`ocx config set ${parent} '{}'`);
      const nested = source.indexOf(`ocx config set ${parent}.`);
      expect(initializer, `the guide no longer initializes an empty ${parent} object`).toBeGreaterThanOrEqual(0);
      expect(nested, `the guide no longer sets any ${parent} field`).toBeGreaterThanOrEqual(0);
      expect(
        initializer,
        `the guide sets a ${parent}.<field> before creating ${parent}, which fails on a fresh config`,
      ).toBeLessThan(nested);
    }

    // Name the error, so a reader who hit it recognizes their own terminal output.
    expect(source).toContain("config parent path not found: hub");
  });

  test("the whole-object form carries its replace-not-merge warning", async () => {
    // `setPath` assigns the leaf. Recommending the one-call form without this warning would tell
    // an operator adapting an existing config to silently drop their management ingress.
    const source = await Bun.file(GUIDE).text();
    expect(source).toContain("replaces** the object");
  });

  test("the guide says opencodex terminates no TLS itself", async () => {
    // There is no tls/cert/key field in OcxConfig. A reader who assumes otherwise looks for a
    // setting that does not exist instead of standing up a frontend.
    const source = await Bun.file(GUIDE).text();
    expect(source).toContain("terminates no TLS of its own");
  });

  test("ocx connect is shown with a data origin and a separate management origin", async () => {
    // The positional URL is where /readyz and /v1/catalog are fetched; --management-url is where
    // pairing and key issuance go. They need not share a port, and the macOS recipe relies on that.
    const source = await Bun.file(GUIDE).text();
    expect(source).toContain("ocx connect https://hub-name.tailnet-name.ts.net:8443");
    expect(source).toContain("--management-url https://hub-name.tailnet-name.ts.net");
  });

  test("the macOS Serve constraint and the loopback-bind trap are both documented", async () => {
    const source = await Bun.file(GUIDE).text();
    // Serve cannot reach a listener bound to the node's own tailnet address.
    expect(source).toContain("Tailscale Serve proxies only to");
    // And the obvious workaround -- bind the listener to loopback -- breaks the catalog quietly.
    expect(source).toContain("403 origin_rejected");
    expect(source).toContain("X-Forwarded-Host");
  });

  test("the Docker section does not contradict the standalone parent-object rule", async () => {
    // Compose seeds a hub object, so its nested sets work. Without saying so, the two sections
    // read as two different rules and the reader cannot tell which applies to them.
    const source = await Bun.file(GUIDE).text();
    expect(source).toContain("because the image seeds a first-run");
  });

  test("the retired --allow-insecure-http flag is not offered", async () => {
    // It is absent from CONNECT_USAGE, pairing refuses non-loopback HTTP outright, and
    // remoteGui.allowInsecureHttp is a retired no-op. Offering it sends an operator to an error.
    const source = await Bun.file(GUIDE).text();
    expect(source).not.toContain("--allow-insecure-http");
  });
});

/**
 * The one-port recipe (#4236). Both locales are in scope: Korean is the only translation this
 * unit rewrote, and a translation that still tells the reader to export a token is worse than a
 * missing one because it contradicts the English page it claims to mirror.
 */
describe("the one-port hub recipe", () => {
  const LOCALES = [["en", GUIDE], ["ko", KO_GUIDE]] as const;

  test("both locales teach the port-less companion form", async () => {
    for (const [locale, file] of LOCALES) {
      const source = await Bun.file(file).text();
      // The companion form IS the recipe: `{"enabled":true}` with no port binds 127.0.0.1 on the
      // proxy port, which is the address every local integration already writes.
      expect(source, locale).toContain(`ocx config set unauthenticatedLoopbackListener '{"enabled":true}'`);
      // The ported form stays documented as the alternative, because existing hubs run it.
      expect(source, locale).toContain(`{"enabled":true,"port":10104}`);
    }
  });

  test("no locale tells the operator to export a data-plane token by hand", async () => {
    for (const [locale, file] of LOCALES) {
      const source = await Bun.file(file).text();
      // Line-anchored, because that is the SHELL STEP the guide used to carry. Prose is still
      // free to name the variable -- it has to, to say the step is gone and why the admin token
      // is refused there. What must not come back is a line telling the reader to export it.
      expect(source, locale).not.toMatch(/^\s*export\s+OPENCODEX_API_AUTH_TOKEN/m);
      // Precedence has to be stated, or the reader cannot tell what an existing file will do.
      expect(source, locale).toContain("service-api-token");
    }
  });

  test("both locales route a new machine through ocx hub invite", async () => {
    for (const [locale, file] of LOCALES) {
      const source = await Bun.file(file).text();
      expect(source, locale).toContain("ocx hub invite");
      // `invite` mints nothing until a loopback browser origin is admitted, and the fix is this
      // exact command. Naming the flag without the precondition sends the operator to a refusal.
      expect(source, locale).toContain(`ocx config set corsAllowOrigins '["http://localhost:10100"]'`);
      expect(source, locale).toContain("--pairing-code-stdin");
    }
  });

  test("the English page keeps the macOS launchd semantics a repair changed", async () => {
    const source = await Bun.file(GUIDE).text();
    // `repair` of a healthy job is a no-op, and `restart` is no longer an alias of it (#4249):
    // `ocx service restart` refreshes the definition and, when nothing was reloaded, kickstarts
    // the loaded job in place. Naming the no-op without naming the verb that DOES restart is what
    // sent operators to a hand-written launchctl command.
    expect(source).toContain("ocx service restart");
    expect(source).toMatch(/`ocx service restart`[^\n]*always restarts/);
    expect(source).not.toMatch(/`ocx service restart` is an alias of `repair`/);
    // The kickstart line stays pinned, but only as the documented manual fallback -- the page has
    // to say so, or it reads as the recommended route again.
    expect(source).toContain("launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy");
    expect(source).toContain("manual fallback");
    // The fourth status state is the one that used to be reported as "not loaded" and sent
    // operators to repair a serving hub.
    expect(source).toContain("launchd state could not be verified");
  });

  test("the English page says the companion listener is not a TLS target", async () => {
    // It is a real socket on 127.0.0.1, so Serve will happily create the mapping -- and then the
    // loopback Host check rejects the forwarded Host exactly as the plain-loopback trap does.
    const source = await Bun.file(GUIDE).text();
    expect(source).toContain("Do not point Serve at the loopback companion listener");
  });
});

describe("remote hub guide translations", () => {
  // Every locale is checked against the SAME expectations as the source, including "en" itself.
  // Putting English in the list is deliberate: it means a future English edit that drops one of
  // these markers fails here too, instead of quietly redefining what the locales owe.
  for (const [locale, path] of LOCALE_GUIDES) {
    describe(locale, () => {
      test("no nested config set runs before its parent object exists", async () => {
        const source = await Bun.file(path).text();

        // Ordering is the whole fix. A guide that sets the field first and shows `{}` further
        // down still fails verbatim on the fresh standalone config it told the reader to build.
        for (const parent of ["hub", "remoteGui"] as const) {
          const initializer = source.indexOf(`ocx config set ${parent} '{}'`);
          const nested = source.indexOf(`ocx config set ${parent}.`);
          expect(initializer, `${locale} no longer initializes an empty ${parent} object`).toBeGreaterThanOrEqual(0);
          expect(nested, `${locale} no longer sets any ${parent} field`).toBeGreaterThanOrEqual(0);
          expect(
            initializer,
            `${locale} sets a ${parent}.<field> before creating ${parent}, which fails on a fresh config`,
          ).toBeLessThan(nested);
        }

        // The error text is terminal output, so it stays literal in every language: it is how a
        // reader who already hit the failure recognizes their own screen.
        expect(source, `${locale} no longer names the error a reader actually sees`)
          .toContain("config parent path not found: hub");
      });

      test("the whole-object alternative carries its replace-not-merge warning", async () => {
        // `setPath` assigns the leaf, so the one-call form drops a pre-existing managementIngress.
        // Each locale words the warning natively, so this pins shape: the alternative exists, and
        // an emphasized caveat follows it before the section ends. Without the second half a
        // locale could keep the convenient line and lose the reason it is dangerous.
        const source = await Bun.file(path).text();
        const wholeObject = source.indexOf(`ocx config set hub '{"managementPublicOrigin"`);
        expect(wholeObject, `${locale} lost the whole-object alternative`).toBeGreaterThanOrEqual(0);

        // Stop at the next heading of ANY level, not just `##`. Bounding on `##` alone let the
        // bold text inside the following `###` data-plane subsection satisfy this check, so
        // deleting the warning itself still passed -- the assertion was decorative in five of the
        // eight files. Two or more hashes also keeps a `# comment` line inside a bash fence from
        // closing the window early.
        const nextHeading = source.slice(wholeObject).search(/\n#{2,6} /);
        const section = source.slice(wholeObject, nextHeading < 0 ? undefined : wholeObject + nextHeading);
        expect(section, `${locale} offers the whole-object form with no emphasized warning`).toContain("**");

        // Emphasis alone is content-free -- any unrelated bold in the window would satisfy it.
        // The warning's actual subject is the setting that silently disappears, and its name is
        // a config path, so it survives translation. A locale that keeps the convenient one-call
        // line and drops the reason it is dangerous fails here.
        expect(
          section,
          `${locale} does not name hub.managementIngress as what a whole-object set drops`,
        ).toContain("hub.managementIngress");
      });

      test("the data plane is given TLS on its own origin", async () => {
        // The management ingress serves no /v1/*, /healthz or /readyz, so a guide that publishes
        // only that ingress leaves a hub that pairs and then cannot answer a request. These are
        // commands, so a translation that dropped the section fails rather than reading fine.
        const source = await Bun.file(path).text();
        expect(source, `${locale} lost the loopback forwarder macOS Serve requires`)
          .toContain("socat TCP-LISTEN:10110,bind=127.0.0.1");
        expect(source, `${locale} lost the second HTTPS mapping for the data listener`)
          .toContain("tailscale serve --bg --https=8443 http://127.0.0.1:10110");
        expect(source, `${locale} lost the data origin on ocx connect`)
          .toContain("ocx connect https://hub-name.tailnet-name.ts.net:8443");
        expect(source, `${locale} lost the separate management origin`)
          .toContain("--management-url https://hub-name.tailnet-name.ts.net");
      });

      test("the quiet loopback-bind trap is documented", async () => {
        // This is the failure the section exists for: a loopback-bound data listener behind a TLS
        // frontend answers 403 on /v1/catalog while /readyz still returns 200, so the deployment
        // looks healthy and serves no model. Both tokens are literal wire values in every locale.
        const source = await Bun.file(path).text();
        expect(source, `${locale} lost the error code the operator actually sees`).toContain("403 origin_rejected");
        expect(source, `${locale} no longer says the frontend cannot repair this`).toContain("X-Forwarded-Host");
      });

      test("the retired --allow-insecure-http flag is not offered", async () => {
        // `rejectArgs` throws "Unexpected argument(s)" on it, pairing refuses non-loopback HTTP
        // with no opt-out, and remoteGui.allowInsecureHttp is a retired no-op kept only so old
        // configs still load. Offering it in any language sends that reader to an error.
        const source = await Bun.file(path).text();
        expect(source, `${locale} still offers the retired flag`).not.toContain("--allow-insecure-http");
      });
    });
  }
});
