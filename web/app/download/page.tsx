import Link from "next/link";
import {
  DOCKER_IMAGE,
  NPM_COMMAND,
  RELEASE_ASSET,
  RELEASE_BASE_URL,
  RELEASE_COMPOSE_ASSET,
  RELEASE_TAG,
  RELEASE_VERSION,
} from "../../lib/release";
import { CopyCommand } from "./CopyCommand";

const manualUrl = `${RELEASE_BASE_URL}/${RELEASE_ASSET}`;
const checksumUrl = `${RELEASE_BASE_URL}/SHA256SUMS`;
const composeUrl = `${RELEASE_BASE_URL}/${RELEASE_COMPOSE_ASSET}`;
const composeCommand = `curl -LO ${composeUrl}\ndocker compose -f ${RELEASE_COMPOSE_ASSET} up -d`;
const manualCommand = `npm install --global ./${RELEASE_ASSET}\nkrelvan`;

export default function DownloadPage() {
  return (
    <main>
      <section style={{ padding: "var(--s9) 0 var(--s8)" }}>
        <div className="container">
          <p className="micro" style={{ color: "var(--brand)", marginBottom: "var(--s3)" }}>
            Krelvan {RELEASE_VERSION} · public beta
          </p>
          <h1 className="display" style={{ maxWidth: "16ch", marginBottom: "var(--s4)" }}>
            Run Krelvan on infrastructure you control.
          </h1>
          <p className="body-lg soft" style={{ maxWidth: "66ch" }}>
            Choose the same version through npm, a container image, or the exact npm
            tarball. The tarball is the manual release artifact, so its GitHub download
            count remains visible without changing what customers receive.
          </p>
        </div>
      </section>

      <section style={{ paddingBottom: "var(--s9)" }}>
        <div
          className="container"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
            gap: "var(--s4)",
          }}
        >
          <article className="card" style={{ padding: "var(--s6)", display: "grid", gap: "var(--s4)" }}>
            <div>
              <p className="micro" style={{ marginBottom: "var(--s2)" }}>Fastest trial</p>
              <h2 style={{ margin: 0 }}>npm</h2>
            </div>
            <p className="small soft">
              Requires Node.js 22 or newer. The explicit version prevents a future release
              from changing an installation you already reviewed.
            </p>
            <CopyCommand command={NPM_COMMAND} />
            <a
              className="btn btn-primary btn-sm"
              href="https://www.npmjs.com/package/krelvan"
              target="_blank"
              rel="noopener noreferrer"
            >
              Inspect on npm
            </a>
          </article>

          <article className="card" style={{ padding: "var(--s6)", display: "grid", gap: "var(--s4)" }}>
            <div>
              <p className="micro" style={{ marginBottom: "var(--s2)" }}>Production path</p>
              <h2 style={{ margin: 0 }}>Container</h2>
            </div>
            <p className="small soft">
              Download the release compose file and start the immutable image. It binds to
              your machine only and keeps data in a persistent volume.
            </p>
            <CopyCommand command={composeCommand} />
            <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap" }}>
              <a className="btn btn-secondary btn-sm" href={composeUrl}>Download compose file</a>
              <a
                className="btn btn-ghost btn-sm"
                href="https://github.com/sreenathmmenon/krelvan/pkgs/container/krelvan"
                target="_blank"
                rel="noopener noreferrer"
              >
                Inspect {DOCKER_IMAGE}
              </a>
            </div>
          </article>

          <article className="card" style={{ padding: "var(--s6)", display: "grid", gap: "var(--s4)" }}>
            <div>
              <p className="micro" style={{ marginBottom: "var(--s2)" }}>Offline / inspectable</p>
              <h2 style={{ margin: 0 }}>Signed release</h2>
            </div>
            <p className="small soft">
              Download the exact tarball published to npm. Verify its checksum and GitHub
              artifact attestation before installing it on a disconnected system.
            </p>
            <CopyCommand command={manualCommand} />
            <a className="btn btn-primary btn-sm" href={manualUrl}>
              Download {RELEASE_ASSET}
            </a>
            <div style={{ display: "flex", gap: "var(--s4)", flexWrap: "wrap" }}>
              <a className="small" href={checksumUrl}>SHA-256 checksums</a>
              <a
                className="small"
                href={`https://github.com/sreenathmmenon/krelvan/releases/tag/${RELEASE_TAG}`}
              >
                Release and attestations
              </a>
            </div>
          </article>
        </div>
      </section>

      <section style={{ padding: "0 0 var(--s9)" }}>
        <div className="container">
          <div className="card" style={{ padding: "var(--s6)", maxWidth: "92ch" }}>
            <p className="micro" style={{ marginBottom: "var(--s2)" }}>After you start it</p>
            <h2 style={{ marginBottom: "var(--s4)" }}>Your first five minutes</h2>
            <ol className="small soft" style={{ margin: 0, paddingLeft: "var(--s5)", display: "grid", gap: "var(--s3)", lineHeight: 1.65 }}>
              <li>The first npm start installs and builds the web app, so it can take a few minutes. Later starts reuse that build.</li>
              <li>Open <code>http://localhost:3100</code>. Copy the one-time setup token printed in the terminal and create the admin account for this installation.</li>
              <li>Open <strong>Settings → Model &amp; secrets</strong>. Connect a hosted provider, an OpenAI-compatible endpoint, or local Ollama.</li>
              <li>Return to the Dashboard, describe an outcome, review the compiled plan, and choose <strong>Run now</strong>.</li>
              <li>Your result appears in Inbox; its signed timeline and downloadable record are available from Runs.</li>
            </ol>
            <div style={{ marginTop: "var(--s5)", paddingTop: "var(--s4)", borderTop: "1px solid var(--line)", display: "grid", gap: "var(--s2)" }}>
              <p className="small" style={{ margin: 0 }}>
                <strong>No krelvan.com account is created.</strong> Your admin credential, agents, model configuration, and records belong only to your self-hosted installation.
              </p>
              <p className="small soft" style={{ margin: 0 }}>
                The npm launcher stores persistent data in <code>~/.krelvan</code>. <code>Ctrl-C</code> stops it; run the same command again to restart. Back up that data directory before upgrades.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section style={{ padding: "0 0 var(--s9)" }}>
        <div className="container">
          <div className="card" style={{ padding: "var(--s6)", maxWidth: "76ch" }}>
            <h2 style={{ marginBottom: "var(--s3)" }}>What is counted</h2>
            <p className="small soft" style={{ marginBottom: "var(--s3)" }}>
              npm reports package downloads. GitHub reports downloads of uploaded release
              assets such as the tarball above. Container pulls are reported by the container
              registry. These are channel events—not unique customers—and Krelvan never
              combines them into a misleading user count.
            </p>
            <p className="small soft" style={{ margin: 0 }}>
              Cloning the source repository or downloading an automatically generated source
              archive is not treated as a product download. For a countable manual install,
              use the uploaded release tarball.
            </p>
          </div>
          <p className="small" style={{ marginTop: "var(--s5)" }}>
            Want to review the source first?{" "}
            <a href="https://github.com/sreenathmmenon/krelvan">Open the repository</a>
            {" · "}
            <Link href="/faq">Read the FAQ</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
