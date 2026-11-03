# Exemplo de produtor em Python

*Also in English (main version): [`README.md`](README.md).*

Código funcional que **valida** conversas e as **publica no tópico do Pub/Sub** da plataforma Sales Conversation Intelligence. Serve de ponto de partida para quem vai integrar o seu sistema: copie `producer.py`, ligue ao seu código e adapte o mapeamento.

O guia completo (regras do evento, autenticação, tratamento de erros, checklist) está em [`docs/producer-guide.pt-BR.md`](../../docs/producer-guide.pt-BR.md). Este exemplo é a versão em código desse guia.

## O que tem aqui
| Arquivo | Para quê |
|---|---|
| `producer.py` | A biblioteca e a linha de comando: valida o evento, lê a chave, publica com tentativas automáticas |
| `mapping_example.py` | Como transformar uma conversa **do seu sistema** no evento da plataforma (troque pelo seu mapeamento) |
| `events/` | Três eventos de uma mesma conversa (aberta, com mais mensagens, encerrada), prontos para testar |
| `schema/conversation-event.schema.json` | O contrato do evento (cópia do da plataforma; um teste garante que são iguais) |
| `.env.example` | As variáveis de ambiente, sem nenhum segredo |
| `requirements.txt` | `google-cloud-pubsub` e `jsonschema` |

## Passo a passo
**1. Instale** (Python 3.9 ou mais novo):
```bash
cd samples/producer-python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

**2. Valide os eventos de exemplo (nada é enviado):**
```bash
python producer.py
```
Sem argumentos ele usa os eventos de exemplo de `events/`. Também dá para nomear arquivos: `python producer.py events/*.json` (o `*` funciona mesmo onde o shell não o expande, como numa IDE). Sem `--publish` o programa só confere cada arquivo e diz o que enviaria. Pode rodar à vontade.

**3. Configure e envie.** Copie `.env.example` para `.env`, preencha e carregue:
```bash
cp .env.example .env     # edite: SCI_PROJECT, SCI_TOPIC e a chave
set -a; source .env; set +a
python producer.py --publish
```
A chave da conta de serviço vem **uma** destas formas:
* `SCI_PUBSUB_KEY_JSON`: o texto do JSON (em produção, leia do AWS Secrets Manager para essa variável ao iniciar a aplicação);
* `SCI_PUBSUB_KEY_FILE`: o caminho do arquivo (só para testes locais).

Os eventos de exemplo usam o workspace de teste `org-test/default`. **Combine com a plataforma antes de enviar de verdade**: o workspace precisa estar liberado e cada conversa enviada pode ser analisada pela IA (tem custo para a plataforma). Use `session_id` próprios de teste.

**4. Use no seu código.** O essencial:
```python
from producer import PubSubPublisher, Sender, load_credentials, topic_path

publisher = PubSubPublisher(load_credentials())          # crie UMA vez e reutilize
sender = Sender(publisher, topic_path("PROJETO", "TOPICO"))

message_id = sender.send(evento)       # valida, publica e tenta de novo se a falha for passageira
```
Para montar o `evento` a partir dos seus dados, veja `mapping_example.py` (`python mapping_example.py` imprime um exemplo).

## O que o `Sender` faz por você
* **Valida antes de enviar** com o contrato e com as mesmas regras que a plataforma aplica ao receber (fuso nas datas, `updated_at` nunca antes de `started_at`, nenhuma mensagem anterior ao dia em que a sessão começou, `message_id` sem repetição, no máximo 500 mensagens). Um evento inválido **não é enviado** e a exceção lista todos os problemas, sem mostrar o texto das mensagens.
* **Tenta de novo** o que é passageiro (timeout, conexão, erros 408, 429 e 5xx) com espera crescente (1 s, 2 s, 4 s... até 30 s, com um pouco de aleatoriedade). Reenviar é seguro: a plataforma grava cada mensagem uma vez só.
* **Não insiste** no que não se resolve sozinho (403 chave errada ou sem permissão, 404 tópico errado, 400): levanta `PublishFailed` com a causa, para você corrigir.

## As regras que mais pegam quem integra
1. `session_id` é o id da conversa **no seu sistema**; todos os eventos da mesma conversa usam o mesmo.
2. `started_at` **nunca muda**. `updated_at` **cresce a cada evento** (é a hora da última mudança no seu sistema). Um evento com `updated_at` igual ou mais antigo não altera nada.
3. Mande as mensagens **novas** desde o último evento. Mandar uma antiga de novo é inofensivo.
4. `event_id` é único por evento. Montá-lo com a sessão e o `updated_at` (como o `mapping_example.py`) faz o reenvio da mesma mudança gerar o mesmo id.
5. Toda data em ISO 8601 **com fuso** (`2026-11-02T14:00:05Z`).
6. Mande o evento **quando a conversa mudar**, não a cada tecla: a plataforma espera cerca de 1 minuto sem mensagens antes de analisar.

## Erros comuns
| Sintoma | Causa provável |
|---|---|
| `INVALID` ao rodar | Alguma regra acima; o texto lista cada problema |
| `NOT SENT: not accepted (PermissionDenied)` | Chave errada, apagada ou conta sem permissão no tópico |
| `NOT SENT: not accepted (NotFound)` | `SCI_PROJECT` ou `SCI_TOPIC` errados |
| `still failing after 5 retries` | Problema de rede ou instabilidade do Google; tente mais tarde |
| Enviou sem erro, mas nada aparece | O Pub/Sub aceitou, porém a plataforma recusou o evento depois (workspace não liberado, regra quebrada). A plataforma vê isso do lado dela: avise com o `event_id` |

## Rodando na IDE (IntelliJ IDEA / PyCharm)
1. **Suporte a Python.** O IntelliJ IDEA precisa do plugin *Python* (Settings > Plugins; o PyCharm já traz).
2. **Um interpretador para o exemplo.** File > Project Structure > SDKs > **+** > *Add Python SDK* > *Virtualenv Environment* > *New*, local `samples/producer-python/.venv`, interpretador base Python 3.9 ou mais novo. Depois, em Project Structure > Modules > Dependencies, defina-o como *Module SDK* (ou escolha-o na configuração de execução abaixo).
3. **Instale as bibliotecas.** Abra o terminal da IDE (Alt+F12), `cd samples/producer-python` e `pip install -r requirements.txt` (o terminal ativa o interpretador do projeto; confira que o prompt mostra o `.venv`).
4. **Crie a configuração de execução.** Run > Edit Configurations > **+** > *Python*:
   * *Script path*: `samples/producer-python/producer.py`
   * *Parameters*: deixe **vazio** para usar os eventos de exemplo, ou escreva `events/*.json` (o programa expande o `*` sozinho, o que a IDE não faz); para os seus arquivos, liste-os: `meu-evento-1.json meu-evento-2.json`
   * *Working directory*: `samples/producer-python`
   * *Python interpreter*: o `.venv` do passo 2
   
   Rode: ele só **valida** (imprime `valid ·` para cada arquivo e `Nothing was sent`). Se a IDE mostrar `error: the following arguments are required`, você está com uma cópia antiga: atualize para a última versão.
5. **Para enviar de verdade,** duplique a configuração, ponha `--publish` nos parâmetros (`--publish` sozinho envia os eventos de exemplo) e preencha as *Environment variables*:
   `SCI_PROJECT=jnart-intelligence-513001;SCI_TOPIC=sci-dev-conversations;SCI_PUBSUB_KEY_FILE=/caminho/absoluto/da-chave.json`
   Guarde o arquivo da chave **fora do repositório** (por exemplo `~/.config/sci/`) e deixe *Store as project file* **desmarcado**, para que nada com caminho ou segredo vá para um arquivo `.run/` compartilhado. Um envio bem-sucedido imprime `sent · Pub/Sub message <id>` para cada arquivo.
6. **Para depurar passo a passo,** ponha um breakpoint em `Sender.send` (`producer.py`) e use *Debug* em vez de *Run*.
7. **Para rodar os testes** na IDE, use o `.venv` do próprio repositório como interpretador (Python 3.12) e rode `tests/test_sample_producer.py`: eles não precisam de rede nem de chave.

## Testes
Os testes ficam em `tests/test_sample_producer.py` na raiz do repositório e não precisam de rede nem de chave (usam um publicador falso). Eles conferem, entre outras coisas, que os eventos de exemplo passam **no mesmo modelo de validação que a ingestão da plataforma usa**:
```bash
pytest -q tests/test_sample_producer.py
```
