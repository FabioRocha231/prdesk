// Dev-only: open the Vite URL with ?mock to run the UI in a plain browser on synthetic data (no Tauri, no token).
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const ME = "you";
const HOUR = 3_600_000;
const ago = (hours: number): string => new Date(Date.now() - hours * HOUR).toISOString();

interface Seed {
  n: number;
  repo: string;
  title: string;
  author: string;
  ci?: string;
  draft?: boolean;
  decision?: string | null;
  commitHoursAgo?: number;
  requested?: string[];
  reviews?: [string, string, number][];
  body?: string;
  mergeState?: string;
  threads?: { resolved?: boolean; first: string; last: string; hoursAgo: number; text: string; opening?: string }[];
}

const SEEDS: Seed[] = [
  {
    n: 1943,
    repo: "ggCheckout/saas-checkout",
    title: "Checkout: use the new split-payment API",
    author: ME,
    decision: "APPROVED",
    reviews: [["maria", "APPROVED", 2]],
    body: "Usa a API nova de split.\n\nDepende de ggCheckout/ggcheckout-core#605",
  },
  {
    n: 427,
    repo: "ggCheckout/gg-admin",
    title: "Admin: payout report per seller",
    author: "lia",
    body: "Depends on ggCheckout/ggcheckout-core#605",
  },
  {
    n: 605,
    repo: "ggCheckout/ggcheckout-core",
    title: "Split payments across sellers",
    author: "carla",
    requested: [ME],
    commitHoursAgo: 6,
    mergeState: "BEHIND",
  },
  {
    n: 142,
    repo: "acme/api",
    title: "Refresh expired OAuth tokens before retrying the request",
    author: ME,
    commitHoursAgo: 30,
    threads: [
      {
        first: "maria",
        last: "maria",
        hoursAgo: 5,
        text: "This doesn't handle a 401 coming back from the refresh call itself. Can we bail out instead of looping?",
      },
      {
        first: "joao",
        last: "joao",
        hoursAgo: 3,
        text: "Nit: name this refreshAndRetry so the call sites read better.",
      },
    ],
  },
  {
    n: 88,
    repo: "acme/web",
    title: "Checkout: keep the cart when the session expires mid-payment",
    author: ME,
    ci: "FAILURE",
    commitHoursAgo: 2,
    mergeState: "DIRTY",
  },
  {
    n: 1204,
    repo: "acme/mobile",
    title: "Add offline queue for order status updates",
    author: ME,
    decision: "APPROVED",
    reviews: [["maria", "APPROVED", 1]],
  },
  {
    n: 57,
    repo: "acme/infra",
    title: "Terraform: move staging Postgres to the new subnet",
    author: "carla",
    threads: [
      {
        first: ME,
        last: "carla",
        hoursAgo: 7,
        opening:
          "Should we pin the AWS provider before moving the subnet? An unpinned upgrade could recreate the instance.",
        text: "Good catch, I pinned the provider version. Mind taking another look?",
      },
    ],
  },
  {
    n: 311,
    repo: "acme/api",
    title: "Rate limit the public search endpoint per API key",
    author: "pedro",
    requested: [ME],
  },
  {
    n: 96,
    repo: "acme/design-system",
    title: "Button: focus ring follows the theme ink color",
    author: "lia",
    requested: [ME],
    ci: "PENDING",
  },
  {
    n: 1199,
    repo: "acme/mobile",
    title: "Push notifications for delivery ETA changes",
    author: "rafa",
    commitHoursAgo: 4,
    reviews: [[ME, "COMMENTED", 20]],
  },
  {
    n: 145,
    repo: "acme/api",
    title: "Stream large CSV exports instead of buffering them",
    author: ME,
    commitHoursAgo: 50,
  },
  { n: 90, repo: "acme/web", title: "Spike: server components for the product page", author: ME, draft: true },
  {
    n: 23,
    repo: "acme/docs",
    title: "Document the webhook retry policy",
    author: ME,
    reviews: [["joao", "COMMENTED", 26]],
    commitHoursAgo: 40,
  },
  { n: 312, repo: "acme/api", title: "Bump tokio to 1.48", author: "dependabot", decision: "APPROVED" },
  { n: 99, repo: "acme/web", title: "Remove the legacy coupon banner", author: "lia", decision: "CHANGES_REQUESTED" },
  { n: 60, repo: "acme/infra", title: "Nightly backup verification job", author: "carla" },
];

const HUNK = `@@ -38,9 +38,14 @@ export async function request(path: string, init: RequestInit) {
   const res = await fetch(url(path), withAuth(init));
-  if (res.status === 401) throw new AuthError();
+  if (res.status === 401) {
+    await refreshToken();
+    return await request(path, init);
+  }
   return res;
 }`;

/** A small saas-checkout history: a merged PR branch, an open PR, a branch stacked on it, a tag. */
function mockGraph(prHead: string | null): { remote: string; commits: unknown[] } {
  const c = (hash: string, parents: string[], refs: string[], subject: string, author: string, hours: number) => ({
    hash: hash.padEnd(40, "0"),
    parents: parents.map((p) => p.padEnd(40, "0")),
    refs,
    subject,
    author,
    time: Math.floor((Date.now() - hours * HOUR) / 1000),
  });
  const head = prHead ?? "origin/feature/1943";
  return {
    remote: "git@github.com:ggCheckout/saas-checkout.git",
    commits: [
      c("a1", ["a0"], [head], "checkout: wire the split-payment API", ME, 2),
      c("b3", ["b2"], ["HEAD -> main", "origin/main"], "fix: rounding in seller fees (#1952)", "maria", 5),
      ...(prHead === null ? [c("s1", ["a0"], ["origin/feat/split-ui"], "split UI: seller list", "lia", 7)] : []),
      c("a0", ["b1"], [], "checkout: types for split payments", ME, 20),
      c("b2", ["b1", "f1"], [], "Merge pull request #1940 from ggCheckout/fees", "carla", 26),
      c("f1", ["b0"], [], "fees: charge per seller", "carla", 30),
      c("b1", ["b0"], [], "chore: bump dependencies (#1938)", "dependabot", 40),
      c("b0", ["z0"], ["tag: v1.4.0"], "feat: wallet-only charging (#1930)", ME, 60),
      c("z0", [], [], "release 1.3.0", "maria", 90),
    ],
  };
}

function rawPull(s: Seed): Record<string, unknown> {
  return {
    id: `PR_${s.repo}_${s.n}`,
    number: s.n,
    title: s.title,
    url: `https://github.com/${s.repo}/pull/${s.n}`,
    isDraft: s.draft ?? false,
    createdAt: ago(72 + (s.n % 50)),
    updatedAt: ago(s.n % 9),
    headRefName: `feature/${s.n}`,
    baseRefName: "main",
    body: s.body ?? "",
    mergeable: s.mergeState === "DIRTY" ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: s.mergeState ?? "CLEAN",
    isCrossRepository: false,
    reviewDecision: s.decision ?? null,
    repository: { nameWithOwner: s.repo, url: `https://github.com/${s.repo}` },
    author: { login: s.author },
    commits: {
      nodes: [
        { commit: { committedDate: ago(s.commitHoursAgo ?? 60), statusCheckRollup: { state: s.ci ?? "SUCCESS" } } },
      ],
    },
    reviewRequests: { nodes: (s.requested ?? []).map((login) => ({ requestedReviewer: { login } })) },
    latestReviews: {
      nodes: (s.reviews ?? []).map(([login, state, h]) => ({ author: { login }, state, submittedAt: ago(h) })),
    },
    reviewThreads: {
      nodes: (s.threads ?? []).map((t) => ({
        isResolved: t.resolved ?? false,
        first: { nodes: [{ author: { login: t.first } }] },
        last: {
          nodes: [{ author: { __typename: "User", login: t.last }, createdAt: ago(t.hoursAgo) }],
        },
      })),
    },
    comments: { nodes: [] },
  };
}

function detail(id: string): Record<string, unknown> {
  const seed = SEEDS.find((s) => `PR_${s.repo}_${s.n}` === id);
  const threads = (seed?.threads ?? []).map((t, i) => ({
    id: `T${i}`,
    isResolved: t.resolved ?? false,
    isOutdated: false,
    path: "src/http/client.ts",
    line: 41 + i * 6,
    originalLine: 41,
    comments: {
      nodes: [
        {
          id: `C${i}a`,
          author: { __typename: "User", login: t.first },
          bodyHTML: `<p>${t.opening ?? t.text}</p>`,
          createdAt: ago(t.hoursAgo + 1),
          diffHunk: HUNK,
        },
        ...(t.first === t.last
          ? []
          : [
              {
                id: `C${i}b`,
                author: { __typename: "User", login: t.last },
                bodyHTML: `<p>${t.text}</p>`,
                createdAt: ago(t.hoursAgo),
                diffHunk: HUNK,
              },
            ]),
      ],
    },
  }));
  const botThread = {
    id: "TBOT",
    isResolved: false,
    isOutdated: false,
    path: "src/http/refresh.ts",
    line: 12,
    originalLine: 12,
    comments: {
      nodes: [
        {
          id: "CBOT",
          author: { __typename: "Bot", login: "coderabbitai" },
          bodyHTML: "<p><strong>Nitpick:</strong> consider extracting the retry budget into a constant.</p>",
          createdAt: ago(3),
          diffHunk: HUNK,
        },
      ],
    },
  };
  const longThread = {
    id: "TLONG",
    isResolved: false,
    isOutdated: false,
    path: "src/http/upload.ts",
    line: 22,
    originalLine: 22,
    comments: {
      nodes: [
        {
          id: "CL0",
          author: { __typename: "User", login: "maria" },
          bodyHTML: "<p>Should the retry also cover the upload client? It talks to the same API.</p>",
          createdAt: ago(9),
          diffHunk: HUNK,
        },
        {
          id: "CL1",
          author: { __typename: "User", login: "you" },
          bodyHTML: "<p>Good point. It uses its own fetch wrapper, so it would need the same change there.</p>",
          createdAt: ago(8),
          diffHunk: HUNK,
        },
        {
          id: "CL2",
          author: { __typename: "User", login: "maria" },
          bodyHTML: "<p>Then let's keep it in this PR, otherwise uploads will still fail after the token expires.</p>",
          createdAt: ago(7),
          diffHunk: HUNK,
        },
        {
          id: "CL3",
          author: { __typename: "User", login: "you" },
          bodyHTML: "<p>Done in the last commit, both clients go through <code>request()</code> now.</p>",
          createdAt: ago(6),
          diffHunk: HUNK,
        },
        {
          id: "CL4",
          author: { __typename: "User", login: "bruno" },
          bodyHTML: "<p>Nice. One more thing: can we log the refresh so we can see how often it happens in prod?</p>",
          createdAt: ago(2),
          diffHunk: HUNK,
        },
      ],
    },
  };
  return {
    node: {
      body:
        seed?.body ?? "Retries once after refreshing the token.\n\n- Adds `refreshToken()`\n- Tests for the retry path",
      mergeStateStatus: seed?.mergeState ?? "CLEAN",
      bodyHTML:
        "<p>Retries once after refreshing the token. Covers <code>request()</code> and the upload client.</p><ul><li>Adds <code>refreshToken()</code></li><li>Tests for the retry path</li></ul>",
      additions: 128,
      deletions: 31,
      changedFiles: 6,
      reviewThreads: { nodes: [...threads, longThread, botThread] },
      comments: {
        nodes: [
          {
            id: "IC1",
            author: { __typename: "User", login: "maria" },
            bodyHTML: "<p>Looks close. Two things inline, then I'm happy to approve.</p>",
            createdAt: ago(6),
          },
          {
            id: "IC2",
            author: { __typename: "Bot", login: "vercel" },
            bodyHTML: "<p>Preview deployed to https://acme-web-git-feature.vercel.app</p>",
            createdAt: ago(5),
          },
        ],
      },
      reviews: { nodes: [] },
      mergeable: seed?.mergeState === "DIRTY" ? "CONFLICTING" : "MERGEABLE",
      autoMergeRequest: null,
      repository: { viewerDefaultMergeMethod: "SQUASH", autoMergeAllowed: true },
      latestReviews: { nodes: [{ author: { id: "U_maria" } }] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "test (node 22)",
                      conclusion: seed?.ci === "FAILURE" ? "FAILURE" : "SUCCESS",
                      status: "COMPLETED",
                      databaseId: 901,
                      detailsUrl: "https://github.com/acme/web/actions/runs/77/job/901",
                      checkSuite: { workflowRun: { databaseId: 77 } },
                    },
                    {
                      __typename: "CheckRun",
                      name: "lint",
                      conclusion: "SUCCESS",
                      status: "COMPLETED",
                      databaseId: 902,
                      detailsUrl: null,
                      checkSuite: { workflowRun: { databaseId: 77 } },
                    },
                    { __typename: "StatusContext", context: "vercel/preview", state: "PENDING", targetUrl: null },
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
}

const MOCK_DIFF = `diff --git a/src/http/client.ts b/src/http/client.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/http/client.ts
+++ b/src/http/client.ts
@@ -38,9 +38,12 @@ export async function request(path: string, init: RequestInit) {
   const res = await fetch(url(path), withAuth(init));
-  if (res.status === 401) {
-    await refreshToken();
-    return await request(path, init);
-  }
+  if (res.status === 401 && !init.retried) {
+    const ok = await refreshToken();
+    if (!ok) throw new AuthError();
+    return await refreshAndRetry(path, init);
+  }
   return res;
 }`;

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

const ACTIVITY = [
  {
    id: "n1",
    reason: "review_requested",
    repo: "acme/mobile",
    number: 1199,
    title: "Push notifications for delivery ETA changes",
    updatedAt: minutesAgo(2),
    actor: "carla",
    body: "## O que muda\n\nAvisa o cliente quando o ETA da entrega muda mais de 5 minutos.",
  },
  {
    id: "n2",
    reason: "author",
    repo: "acme/web",
    number: 88,
    title: "Checkout: keep the cart when the session expires mid-payment",
    updatedAt: minutesAgo(9),
    actor: "diego",
    body: "Can we keep the cart id in the payment intent metadata instead of local storage?",
  },
  {
    id: "n3",
    reason: "mention",
    repo: "acme/api",
    number: 142,
    title: "Refresh expired OAuth tokens before retrying the request",
    updatedAt: minutesAgo(40),
    actor: "bruno",
    body: "@you this conflicts with the retry budget, mind taking a look?",
  },
  {
    id: "n4",
    reason: "state_change",
    repo: "acme/docs",
    number: 23,
    title: "Document the webhook retry policy",
    updatedAt: minutesAgo(180),
    actor: null,
    body: null,
  },
];

const MOCK_FILES = [
  {
    filename: "src/http/client.ts",
    status: "modified",
    additions: 6,
    deletions: 1,
    patch: HUNK,
  },
  {
    filename: "src/http/refresh.ts",
    status: "added",
    additions: 14,
    deletions: 0,
    patch:
      "@@ -0,0 +1,14 @@\n+import { store } from './store';\n+\n+let pending: Promise<void> | null = null;\n+\n+/** One refresh at a time: concurrent 401s share it. */\n+export async function refreshToken(): Promise<void> {\n+  pending ??= (async () => {\n+    const res = await fetch('/oauth/refresh', { method: 'POST' });\n+    store.token = (await res.json()).token;\n+  })();\n+  try {\n+    await pending;\n+  } finally {\n+    pending = null;\n+  }\n+}",
  },
  {
    filename: "src/http/client.test.ts",
    status: "modified",
    additions: 18,
    deletions: 2,
    patch:
      "@@ -1,4 +1,6 @@\n import { request } from './client';\n+import { refreshToken } from './refresh';\n+vi.mock('./refresh');\n \n-it('throws on 401', async () => {\n+it('refreshes once on 401', async () => {",
  },
];

/** Canned answers shaped like each prompt's contract, so the UI can be exercised without a real agent. */
function mockAgent(context: string): string {
  if (context.includes("## Changed files"))
    return JSON.stringify({
      summary:
        "Quando a API responde 401, o cliente agora renova o token uma vez e repete a requisição. Um único refresh é compartilhado entre chamadas concorrentes.",
      risks: [
        "Recursão sem limite: se o refresh devolver um token inválido, request() entra em loop.",
        "O erro do refresh é engolido; o usuário vê um 401 genérico.",
      ],
      lookFirst: [
        { path: "src/http/client.ts", why: "a nova recursão em request()" },
        { path: "src/http/refresh.ts", why: "o compartilhamento do refresh em andamento" },
      ],
      comments: [
        {
          path: "src/http/client.ts",
          line: 41,
          body: "Isso pode virar loop infinito se o token renovado também for rejeitado. Vale passar um `retried = true` e só tentar uma vez.",
        },
        {
          path: "src/http/refresh.ts",
          line: 8,
          body: "Se o POST falhar, `res.json()` lança e o erro sobe sem contexto. Checar `res.ok` antes.",
        },
      ],
    });
  if (context.includes("## Thread on"))
    return "Boa. Troquei o nome para `refreshAndRetry` e deixei a recursão limitada a uma tentativa.";
  if (context.includes("# Task"))
    return JSON.stringify({
      title: "feat(webhooks): retry com backoff no envio",
      body: "## O que muda\n\nReenvia webhooks com backoff exponencial.\n\n## Como testar\n\n`pnpm test webhooks`",
    });
  return "## O que muda\n\nRenova o token uma vez ao receber 401 e repete a requisição.\n\n## Como testar\n\n`pnpm test http`";
}

export function installMocks(): void {
  mockWindows("main");
  let nextId = 1;
  mockIPC((cmd, payload) => {
    const args = (payload ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "token_status":
        return { source: "gh" };
      case "worktree_changes":
        return { files: [" M src/http/client.ts"], diff: MOCK_DIFF, truncated: false, unpushed: 0 };
      case "commit_and_push":
        return "a1b2c3d";
      case "save_ci_log":
        return "/Users/you/PRDesk/.ci-logs/acme-web-901.log";
      case "github_graphql": {
        const query = String(args.query);
        if (query.trimStart().startsWith("mutation")) return {};
        if (query.startsWith("query { viewer")) return { viewer: { login: ME } };
        if (query.includes("viewerViewedState"))
          return {
            node: {
              files: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ path: "src/http/client.test.ts", viewerViewedState: "VIEWED" }],
              },
            },
          };
        if (query.includes("merged: search")) {
          const item = (n: number, repo: string, title: string) => ({
            number: n,
            title,
            url: `https://github.com/${repo}/pull/${n}`,
            repository: { nameWithOwner: repo },
          });
          return {
            merged: { nodes: [item(1188, "acme/mobile", "Cache the delivery map tiles")] },
            opened: { nodes: [item(142, "acme/api", "Refresh expired OAuth tokens before retrying the request")] },
            reviewed: { nodes: [item(311, "acme/api", "Rate limit the public search endpoint per API key")] },
          };
        }
        if (query.includes("nodes(ids")) {
          const ids = (args.variables as { ids: string[] }).ids;
          return { nodes: ids.map((id) => SEEDS.map(rawPull).find((p) => p.id === id) ?? null) };
        }
        if (query.includes("node(id")) return detail(String((args.variables as { id: string }).id));
        const q = String((args.variables as { q: string }).q);
        return {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: q.includes("involves") ? SEEDS.map(rawPull) : [],
          },
        };
      }
      case "github_notifications":
        return { items: ACTIVITY, lastModified: null, pollSeconds: 60 };
      case "github_rest": {
        const path = String(args.path);
        if (String(args.method) === "GET" && path.includes("/files")) return MOCK_FILES;
        return {};
      }
      case "agent_run":
        return mockAgent(String(args.context ?? ""));
      case "git_graph":
        return mockGraph(null);
      case "git_repos":
        return [
          {
            path: "/env/ggcheckout-core",
            name: "ggcheckout-core",
            remote: "git@github.com:ggCheckout/ggcheckout-core.git",
          },
          { path: "/env/saas-checkout", name: "saas-checkout", remote: "git@github.com:ggCheckout/saas-checkout.git" },
          { path: "/env/gg-admin", name: "gg-admin", remote: "https://github.com/ggCheckout/gg-admin" },
          { path: "/env/infra", name: "infra", remote: null },
        ];
      case "git_fetch":
        return null;
      case "pr_graph":
        return mockGraph(`origin/pr/${(args.req as { number: number }).number}`);
      case "plugin:dialog|open":
        return "/Users/you/Projects/ggcheckout-environment";
      case "prepare_branch":
        return "/Users/you/PRDesk/acme/web-prdesk-task";
      case "write_agent_context":
        return null;
      case "prepare_worktree":
        return "/Users/you/PRDesk/acme/infra-pr-57";
      case "pty_spawn":
        return nextId++;
      case "pty_attach":
        return btoa(
          "\x1b[1m~/PRDesk/acme/infra-pr-57\x1b[0m $ claude 'Read the unresolved review threads...'\r\n\r\n" +
            "\x1b[38;5;208m*\x1b[0m Reading 1 unresolved thread on acme/infra#57...\r\n" +
            "  carla: Good catch, I pinned the provider version.\r\n\r\n" +
            "\x1b[38;5;208m*\x1b[0m Checking providers.tf for the pinned version\r\n",
        );
      case "plugin:store|load":
        return nextId++;
      case "plugin:store|get":
        return [null, false];
      case "plugin:event|listen":
        return nextId++;
      default:
        return null;
    }
  });
}

/** `?mock&keys=jj` replays keystrokes after load, so headless screenshots can capture selected states. */
export function replayKeys(): void {
  const keys = [...(new URLSearchParams(window.location.search).get("keys") ?? "")];
  keys.forEach((key, i): void => {
    window.setTimeout(
      (): void => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key }));
      },
      800 + i * 400,
    );
  });
}

/** Headless captures never paint a frame, so view transitions would hold state updates forever. */
export function disableViewTransitions(): void {
  if (new URLSearchParams(window.location.search).has("keys")) {
    Object.defineProperty(document, "startViewTransition", { value: undefined });
  }
}
