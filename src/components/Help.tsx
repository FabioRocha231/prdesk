import { CircleHelp } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef } from "react";

const GUIDE: { title: string; items: [string, string][] }[] = [
  {
    title: "O quadro",
    items: [
      ["Sua vez", "o que espera você agora. Comece por aqui."],
      ["Review pedido", "PRs de outras pessoas aguardando o seu review."],
      ["Aguardando", "suas PRs esperando os outros."],
      ["Novidades", "o que aconteceu nas suas PRs, igual às notificações do GitHub."],
      ["Árvore", "escolha a pasta de um repositório: todas as branches, quais têm PR e as PRs mergeadas."],
      [
        "Depende de",
        "escreva “Depende de org/repo#123” na descrição: a PR espera a outra ser mergeada e você é avisado quando ela sai.",
      ],
      ["Conflitos / Desatualizada", "a branch precisa de ajuste. Conflito na sua PR vira Sua vez e gera aviso."],
      ["Parada há", "sua PR espera review há dias. Dentro dela, o próximo passo é cutucar quem foi pedido."],
      ["Sem PR", "branches que você subiu nos últimos 14 dias e ainda não têm PR. Clique para abrir uma."],
      ["Base falhando", "a branch principal do repo está com o CI vermelho: as PRs dele podem falhar por isso."],
      ["Issues", "as issues atribuídas a você. Começar uma abre o agente e a PR fecha a issue."],
      [
        "Missões",
        "uma mudança em vários repos: um agente escreve o plano com o contrato entre eles, você revisa e um agente por repo trabalha em paralelo.",
      ],
    ],
  },
  {
    title: "Dentro de uma PR",
    items: [
      ["Próximo passo", "o botão destacado no topo diz o que fazer agora. O resto fica em Mais."],
      ["Arquivos", "o diff completo: comente em qualquer linha, marque como visto e envie o review."],
      ["Comentários", "as conversas no código. Responda, resolva ou mande o agente corrigir."],
      ["Conversa", "a descrição e os comentários gerais da PR."],
      ["CI", "os checks. Se algo falhar, o agente lê o log e corrige."],
      ["Aplicar sugestão", "num comentário com sugestão de código: vira um commit na branch e a conversa é resolvida."],
      ["Mais", "labels, responsáveis, pedir review de novo, cutucar revisores e fechar a PR."],
      ["Árvore", "de onde a branch saiu, o que entrou na base depois e para onde ela vai quando mesclar."],
    ],
  },
  {
    title: "IA",
    items: [
      ["Analisar", "em Arquivos: resumo, riscos e comentários de rascunho para você revisar."],
      ["Resolver tudo", "na sua PR: o agente ataca os comentários pendentes e o CI de uma vez."],
      ["Rascunhar com IA", "ao responder um comentário, a IA escreve e você só ajusta."],
      ["Nova PR", "descreva a tarefa; o agente implementa numa branch nova e a IA escreve a PR."],
    ],
  },
];

const KEYS: [string, string][] = [
  ["J / K", "próxima / anterior"],
  ["Enter", "abrir a PR destacada"],
  ["Esc", "voltar ao quadro"],
  ["C", "abrir no agente"],
  ["O", "abrir no GitHub"],
  ["⌘K", "buscar PR"],
  ["N", "novidades"],
  ["I", "issues atribuídas a você"],
  ["P", "nova PR"],
  ["T", "árvore de branches"],
  ["M", "missões"],
  ["1–9 / 0", "filtrar por repositório / todos"],
  ["R", "atualizar"],
  [",", "ajustes"],
  ["?", "esta ajuda"],
];

export function HelpDialog({ onClose }: { onClose: () => void }): ReactElement {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect((): void => {
    dialog.current?.showModal();
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse shortcut; Esc closes the dialog natively
    <dialog
      ref={dialog}
      className="palette help"
      aria-label="Como usar o prdesk"
      onClose={onClose}
      onClick={(e): void => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="palette-input">
        <CircleHelp size={18} strokeWidth={2} aria-hidden />
        <span className="feed-heading">Como usar o prdesk</span>
        <kbd>Esc</kbd>
      </div>
      <div className="help-body">
        <div className="help-guide">
          {GUIDE.map(
            (section): ReactElement => (
              <section key={section.title}>
                <h2>{section.title}</h2>
                <dl>
                  {section.items.map(
                    ([term, text]): ReactElement => (
                      <div key={term}>
                        <dt>{term}</dt>
                        <dd>{text}</dd>
                      </div>
                    ),
                  )}
                </dl>
              </section>
            ),
          )}
        </div>
        <aside className="help-keys" aria-label="Atalhos">
          <h2>Atalhos</h2>
          <dl>
            {KEYS.map(
              ([key, what]): ReactElement => (
                <div key={key}>
                  <dt>
                    <kbd>{key}</kbd>
                  </dt>
                  <dd>{what}</dd>
                </div>
              ),
            )}
          </dl>
        </aside>
      </div>
    </dialog>
  );
}
