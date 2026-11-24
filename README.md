# balance-lojapod

Agente de Balança do Podi Pedir para Windows (`balance-agent-setup.exe`).

Lê a balança do balcão (USB/serial) e manda o peso para a API (`/scale`), que repassa ao PDV do Admin
(Novo Pedido e Editar Pedido) em qualquer aparelho da mesma loja.

## Como funciona

- **Ativação:** o mesmo token da impressora (Admin → Apps). Na ativação dá para dar um nome à balança,
  por exemplo "Balança Caixa 1", que aparece no PDV.
- **Configuração:** porta, marca e velocidade são escolhidas no Admin (Apps → Agente de Balança →
  Configurar balança) e ficam salvas em `%APPDATA%/Podi Pedir Balança/balance_agent_config.json`.
  Com porta ou marca em "automática", o app procura a balança ao abrir.
- **Peso:** só é enviado enquanto algum PDV acompanha esta balança: na hora em que muda (no máximo
  cerca de 5 vezes por segundo) e, parado, uma vez por segundo como sinal de vida.
- Abre junto com o Windows, fica no ícone perto do relógio e se atualiza sozinho (GitHub Releases).

## Marcas (drivers)

Um arquivo por marca em `src/drivers/`, todos no mesmo formato (`factories.js`):

| Driver | Protocolo esperado |
|---|---|
| `toledo`, `filizola`, `elgin` | pedido ENQ; resposta com 5 dígitos em gramas (`00650` = 0,650 kg); `IIIII` = instável |
| `urano` | pedido ENQ; resposta em texto (`0,650 kg`) |
| `generic` | balança que manda o peso sozinha em texto (`ST,GS,+0.650kg`, `650 g`) |
| `simulator` | sem balança: prato de 0,700 kg que estabiliza, para testar o PDV |

> Os formatos de cada marca ainda precisam ser confirmados com a balança física. As amostras dos testes
> são exemplos no formato esperado, não capturas reais.

Para uma marca nova, crie `src/drivers/<marca>.js` e acrescente em `src/drivers/index.js`.

## Desenvolvimento

```bash
npm install
npm test          # testes (node:test), sem Electron
npm start         # abre o app (precisa do .env com API_URL)
npm run build     # gera dist/balance-agent-setup.exe
```

O `release.yml` roda a cada push na `main`: testes, versão patch, instalador e release no GitHub.
Precisa do secret/variável `API_URL` no repositório.
