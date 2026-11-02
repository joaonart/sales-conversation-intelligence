# Guia do produtor: como enviar conversas para a plataforma (Sales Conversation Intelligence)

Para quem vai integrar o **seu aplicativo (rodando na AWS)** à plataforma. Você publica **uma mensagem por mudança de conversa** num tópico do Google Pub/Sub. A plataforma valida, grava e analisa. Você não acessa banco de dados nem precisa de mais nada além do que está neste guia.

## O que a plataforma entrega para você
| Item | Valor |
|---|---|
| Projeto Google Cloud | `jnart-intelligence-513001` |
| Tópico | `projects/jnart-intelligence-513001/topics/sci-dev-conversations` |
| Conta de serviço | `sci-dev-producer@jnart-intelligence-513001.iam.gserviceaccount.com` (pode **só publicar nesse tópico**: não lê dados, não vê resultados) |
| Chave da conta de serviço | um arquivo JSON, entregue por um **canal seguro** (nunca por e-mail ou chat) |
| Seu `organization_id` e `workspace_id` | combinados com a plataforma **antes** do primeiro envio |
| Contrato e exemplo | `contracts/conversation-event.schema.json` e `contracts/conversation-event.example.json` |

## Passo a passo

### 1. Guarde a chave com segurança
A chave é uma senha: quem a tem pode publicar em seu nome.
* Guarde o JSON no **AWS Secrets Manager** (ou no cofre que vocês usam). **Nunca** no código, no repositório, em imagem de contêiner ou em log.
* Entregue-o ao aplicativo por variável de ambiente ou leitura do Secrets Manager na inicialização.
* Combine com a plataforma uma **troca a cada 90 dias** (a plataforma cria uma chave nova, vocês trocam, e a antiga é apagada).
* Se a chave vazar, avise **na hora**: ela é apagada e outra é emitida.

### 2. Instale a biblioteca do Pub/Sub
```bash
pip install google-cloud-pubsub jsonschema      # Python
npm install @google-cloud/pubsub                 # Node.js
```

### 3. Monte a mensagem (um evento por mudança)
O evento traz o **estado atual da sessão** e as **mensagens novas ou alteradas** desde o último envio. Reenviar mensagens já enviadas é inofensivo.
```json
{
  "event_id": "evt-000123",
  "organization_id": "SEU_ORG",
  "workspace_id": "SEU_WORKSPACE",
  "session": {
    "session_id": "s9001", "channel": "whatsapp", "customer_id": "c-77", "seller_id": "v-12",
    "status": "open",
    "started_at": "2026-11-01T14:00:00Z", "updated_at": "2026-11-01T14:07:30Z", "closed_at": null
  },
  "messages": [
    {"message_id": "m1", "sender_type": "customer", "content": "Oi, quero saber o preço do plano anual.", "created_at": "2026-11-01T14:00:05Z", "sequence_number": 1}
  ]
}
```
**Regras (todas verificadas pela plataforma):**
* `event_id`: único por evento enviado (por exemplo, um UUID).
* `session.session_id`: o identificador da conversa no **seu** sistema; é o que liga todos os eventos da mesma conversa.
* `started_at` **nunca muda** para uma sessão. `updated_at` **precisa crescer a cada mudança**; um evento com `updated_at` igual ou mais antigo que o já gravado não altera nada (é o que protege contra eventos fora de ordem).
* Toda data é ISO 8601 **com fuso** (`2026-11-01T14:00:05Z`) e não pode estar mais de 1 dia no futuro.
* `message_id` é único dentro da sessão: a mesma mensagem enviada de novo é gravada **uma vez só**.
* Nenhuma mensagem pode ter data **anterior ao dia em que a sessão começou**.
* No máximo **500 mensagens por evento** e 100.000 caracteres por mensagem. Conversa longa: vários eventos.
* `sender_type`: `customer`, `seller`, `bot` ou `system`. `status`: `open` ou `closed`.
* Não envie campos fora do contrato: o evento é recusado.
* Envie **só o necessário**: a plataforma mascara CPF, e-mail e telefone, mas nomes não.

### 4. Publique
**Python**
```python
import json, os
from google.cloud import pubsub_v1
from google.oauth2 import service_account

TOPIC = "projects/jnart-intelligence-513001/topics/sci-dev-conversations"
info = json.loads(os.environ["SCI_PUBSUB_KEY_JSON"])            # vem do Secrets Manager
creds = service_account.Credentials.from_service_account_info(info, scopes=["https://www.googleapis.com/auth/pubsub"])
publisher = pubsub_v1.PublisherClient(credentials=creds)         # crie UMA vez e reutilize

def enviar(evento: dict) -> str:
    dados = json.dumps(evento, ensure_ascii=False).encode("utf-8")
    return publisher.publish(TOPIC, dados).result(timeout=30)     # devolve o id da mensagem; lança erro se não foi aceita
```
**Node.js**
```js
const { PubSub } = require('@google-cloud/pubsub');
const pubsub = new PubSub({ projectId: 'jnart-intelligence-513001', credentials: JSON.parse(process.env.SCI_PUBSUB_KEY_JSON) });
const topico = pubsub.topic('sci-dev-conversations');                     // crie UMA vez e reutilize
const enviar = (evento) => topico.publishMessage({ json: evento });       // devolve o id da mensagem; rejeita se não foi aceita
```
Antes do primeiro envio, valide o JSON contra o contrato (Python): `jsonschema.validate(evento, json.load(open("conversation-event.schema.json")))`.

### 5. Quando enviar
* Envie **quando a conversa mudar** (mensagem nova, sessão encerrada), não a cada tecla nem num relógio.
* Não precisa agrupar: a plataforma espera a conversa **parar de receber mensagens por cerca de 1 minuto** antes de analisar, e junta os avisos repetidos. Dez mensagens seguidas viram **uma** análise.
* Uma análise **só custa** se o conteúdo mudou. Reenviar o mesmo conteúdo não gera custo.
* Ao encerrar a conversa, envie um evento com `status: "closed"`, `closed_at` e um `updated_at` maior.

### 6. Trate as falhas
* `publish(...).result()` **lançou erro** (rede, 5xx): tente de novo com espera crescente (1 s, 2 s, 4 s... até alguns minutos). Reenviar é seguro: nada é gravado em duplicidade.
* Erro **403 / PERMISSION_DENIED**: a chave está errada, foi apagada ou a conta perdeu a permissão. Não adianta repetir; fale com a plataforma.
* Erro **404 / NOT_FOUND** no tópico: nome do tópico errado.
* O Pub/Sub aceitou o envio, **mas o evento é inválido** (regra quebrada, workspace não liberado): a plataforma recusa depois, 5 vezes, e o guarda **7 dias** para investigação, sem você ver erro. Por isso a validação do passo 4 e o teste do passo 7 são importantes. Se algo não aparecer, avise a plataforma com o `event_id`: ela corrige e reenvia.
* A entrega é **pelo menos uma vez** e **sem ordem garantida**: a plataforma já trata duplicatas e eventos fora de ordem (por isso `updated_at` e `message_id`).

### 7. Teste antes de ligar de verdade
1. Combine o `organization_id`/`workspace_id` de **teste** com a plataforma (ela precisa liberá-los).
2. Publique o evento de exemplo ajustado para o seu workspace, com um `session_id` de teste.
3. Peça à plataforma para confirmar que a sessão e as mensagens chegaram. Se o workspace tiver uma rubrica, a análise aparece em cerca de 1 a 2 minutos.
4. Reenvie o **mesmo** evento: nada deve mudar (nenhuma duplicata).
5. Envie um segundo evento com `updated_at` maior e uma mensagem nova: só a mensagem nova é acrescentada.

### 8. Limites e custo
* Um evento do Pub/Sub tem no máximo **10 MB**.
* O custo do Pub/Sub no seu lado é de centavos por milhares de eventos.
* O custo da análise com IA é da plataforma e tem teto mensal. Se o teto for atingido, as análises pausam, mas **as conversas continuam sendo gravadas**.

## Checklist de entrega (para quem libera o acesso)
- [ ] Conta de serviço criada (`sci-dev-producer`), com permissão de publicar **só** no tópico.
- [ ] `organization_id/workspace_id` do cliente liberados na ingestão e, se for analisar ao vivo, no worker ao vivo.
- [ ] Chave JSON gerada por **quem libera o acesso**, entregue por canal seguro, e o arquivo local **apagado** depois.
- [ ] Este guia, o contrato e o exemplo entregues.
- [ ] Teste do passo 7 acompanhado.
- [ ] Data da primeira troca de chave (90 dias) combinada.

### Como gerar e trocar a chave (para quem libera o acesso)
```bash
# gerar (guarde o arquivo num lugar seguro, entregue-o e apague a cópia local)
gcloud iam service-accounts keys create sci-dev-producer-key.json \
  --iam-account=sci-dev-producer@jnart-intelligence-513001.iam.gserviceaccount.com
# listar as chaves e apagar a antiga depois da troca
gcloud iam service-accounts keys list   --iam-account=sci-dev-producer@jnart-intelligence-513001.iam.gserviceaccount.com
gcloud iam service-accounts keys delete KEY_ID --iam-account=sci-dev-producer@jnart-intelligence-513001.iam.gserviceaccount.com
```
A chave **não é criada pelo Terraform** (ela ficaria no estado). Se o comando de criação for recusado, o projeto ou a organização tem a política `iam.disableServiceAccountKeyCreation`, que precisa ser ajustada por quem administra a organização.
