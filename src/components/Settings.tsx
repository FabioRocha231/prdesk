import type { FormEvent, ReactElement } from "react";
import { useEffect, useState } from "react";

import { type Agent, type Config, DEFAULT_CONFIG, isValidScope } from "../lib/config";
import { clearToken, errorMessage, saveToken, type TokenSource, tokenStatus } from "../lib/ipc";

const TOKEN_LABEL: Record<TokenSource, string> = {
  keychain: "Usando o token salvo no keychain do sistema.",
  gh: "Usando o token do GitHub CLI (gh auth token).",
};

function TokenField({ onChange }: { onChange: () => void }): ReactElement {
  const [source, setSource] = useState<TokenSource | null | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setSource(await tokenStatus());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: checks the token once on mount
  useEffect((): void => {
    void refresh();
  }, []);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await action();
      setDraft("");
      await refresh();
      onChange();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="field">
      <label htmlFor="token">Token do GitHub</label>
      <div className="field-body">
        <p className="hint">
          {source === undefined && "Verificando…"}
          {source === null && "Nenhum token encontrado. Cole um token ou rode gh auth login."}
          {source != null && TOKEN_LABEL[source]}
        </p>
        <div className="inline">
          <input
            id="token"
            className="input"
            type="password"
            autoComplete="off"
            placeholder="ghp_… ou github_pat_…"
            value={draft}
            maxLength={512}
            onChange={(e): void => setDraft(e.target.value)}
            style={{ flex: 1, minWidth: 220 }}
          />
          <button
            type="button"
            className="button"
            disabled={draft.trim() === ""}
            onClick={(): void => void run(async () => await saveToken(draft))}
          >
            Salvar token
          </button>
          {source === "keychain" && (
            <button type="button" className="text-button" onClick={(): void => void run(clearToken)}>
              Remover
            </button>
          )}
        </div>
        <p className="hint">Escopos necessários: repo e read:org. O token fica só no keychain desta máquina.</p>
        {error !== null && (
          <p className="hint error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

function newAgentId(): string {
  return `agent-${crypto.randomUUID().slice(0, 8)}`;
}

export function Settings({
  config,
  firstRun,
  onSave,
  onTokenChange,
  onClose,
}: {
  config: Config;
  firstRun: boolean;
  onSave: (config: Config) => Promise<void>;
  onTokenChange: () => void;
  onClose: () => void;
}): ReactElement {
  const [draft, setDraft] = useState<Config>(config);
  const [scopesText, setScopesText] = useState(config.scopes.join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scopes = scopesText
    .split("\n")
    .map((s): string => s.trim())
    .filter((s): boolean => s !== "");
  const badScopes = scopes.filter((s): boolean => !isValidScope(s));
  const badAgents = draft.agents.filter((a): boolean => a.name.trim() === "" || !a.command.includes("{prompt}"));
  const apiOk = draft.apiUrl.startsWith("https://");
  const valid = badScopes.length === 0 && badAgents.length === 0 && apiOk;

  const updateAgent = (id: string, patch: Partial<Agent>): void =>
    setDraft({ ...draft, agents: draft.agents.map((a): Agent => (a.id === id ? { ...a, ...patch } : a)) });

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...draft, scopes });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings" aria-label="Configurações">
      <div className="settings-intro">
        <h1>{firstRun ? "Conecte ao GitHub" : "Ajustes"}</h1>
        <p>
          {firstRun
            ? "Precisamos de um token para ler suas PRs. Depois, diga quais orgs e repos acompanhar."
            : "Tudo fica nesta máquina: o token no keychain, o resto num arquivo de configuração local."}
        </p>
      </div>

      <form className="settings-form" onSubmit={(e): void => void submit(e)}>
        <TokenField onChange={onTokenChange} />

        <div className="field">
          <label htmlFor="scopes">Orgs e repos</label>
          <div className="field-body">
            <textarea
              id="scopes"
              className="input"
              rows={5}
              placeholder={"minha-org\nfulano/projeto"}
              value={scopesText}
              onChange={(e): void => setScopesText(e.target.value)}
            />
            <p className="hint">
              Um por linha: uma org inteira ou dono/repo. PRs que envolvem você aparecem mesmo fora desta lista.
            </p>
            {badScopes.length > 0 && <p className="hint error">Formato inválido: {badScopes.join(", ")}</p>}
          </div>
        </div>

        <div className="field">
          <span className="label">Agentes</span>
          <div className="field-body">
            {draft.agents.map(
              (a): ReactElement => (
                <div className="agent-row" key={a.id}>
                  <input
                    className="input"
                    aria-label="Nome do agente"
                    value={a.name}
                    onChange={(e): void => updateAgent(a.id, { name: e.target.value })}
                  />
                  <input
                    className="input"
                    aria-label={`Comando do ${a.name}`}
                    value={a.command}
                    onChange={(e): void => updateAgent(a.id, { command: e.target.value })}
                  />
                  <input
                    className="input"
                    aria-label={`Comando sem terminal do ${a.name}`}
                    placeholder="sem terminal: claude -p {prompt}"
                    title="Usado pela IA do app (análise de PR, rascunho de respostas). Deve imprimir a resposta e sair."
                    value={a.headless}
                    onChange={(e): void => updateAgent(a.id, { headless: e.target.value })}
                  />
                  <button
                    type="button"
                    className="text-button"
                    disabled={draft.agents.length === 1}
                    onClick={(): void =>
                      setDraft({ ...draft, agents: draft.agents.filter((x): boolean => x.id !== a.id) })
                    }
                  >
                    Remover
                  </button>
                </div>
              ),
            )}
            <div className="inline">
              <button
                type="button"
                className="button"
                onClick={(): void =>
                  setDraft({
                    ...draft,
                    agents: [...draft.agents, { id: newAgentId(), name: "", command: "{prompt}", headless: "" }],
                  })
                }
              >
                Adicionar agente
              </button>
              <label className="inline">
                Padrão
                <select
                  className="input"
                  style={{ width: "auto" }}
                  value={draft.defaultAgentId}
                  onChange={(e): void => setDraft({ ...draft, defaultAgentId: e.target.value })}
                >
                  {draft.agents.map(
                    (a): ReactElement => (
                      <option key={a.id} value={a.id}>
                        {a.name || "(sem nome)"}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </div>
            <p className="hint">
              O comando roda no seu shell, dentro do worktree da PR. {"{prompt}"} vira as instruções para o agente. O
              segundo campo é a versão sem terminal (imprime a resposta e sai), usada pela IA do app: análise de PR,
              rascunho de respostas e descrição de PR.
            </p>
            {badAgents.length > 0 && (
              <p className="hint error">Todo agente precisa de nome e de {"{prompt}"} no comando.</p>
            )}
          </div>
        </div>

        <div className="field">
          <label htmlFor="workspace">Pasta dos worktrees</label>
          <div className="field-body">
            <input
              id="workspace"
              className="input"
              placeholder="~/PRDesk"
              value={draft.workspaceDir}
              onChange={(e): void => setDraft({ ...draft, workspaceDir: e.target.value.trim() })}
            />
            <p className="hint">Vazio usa ~/PRDesk. O prdesk clona cada repo uma vez e cria um worktree por PR.</p>
          </div>
        </div>

        <div className="field">
          <label htmlFor="api">API do GitHub</label>
          <div className="field-body">
            <input
              id="api"
              className="input"
              value={draft.apiUrl}
              onChange={(e): void => setDraft({ ...draft, apiUrl: e.target.value.trim() })}
            />
            <p className="hint">Troque só para GitHub Enterprise: https://seu-host/api/graphql.</p>
            {!apiOk && <p className="hint error">A URL precisa começar com https://.</p>}
          </div>
        </div>

        <div className="settings-save">
          <button type="submit" className="button primary" disabled={!valid || saving}>
            {saving ? "Salvando…" : "Salvar"}
          </button>
          {!firstRun && (
            <button type="button" className="text-button" onClick={onClose}>
              Voltar ao quadro <kbd>esc</kbd>
            </button>
          )}
          <button
            type="button"
            className="text-button"
            onClick={(): void => {
              setDraft({ ...draft, agents: DEFAULT_CONFIG.agents, defaultAgentId: DEFAULT_CONFIG.defaultAgentId });
            }}
          >
            Restaurar agentes padrão
          </button>
          {error !== null && (
            <p className="hint error" role="alert">
              {error}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
