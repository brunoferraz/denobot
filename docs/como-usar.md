# Como usar o bot

Manual para quem vai lançar gastos — não precisa saber nada de técnico.

## 1. Manda o valor

Só o número, sozinho numa mensagem.

```
50        12,90        1.234,56        R$ 30
```

O bot repete o valor que entendeu antes de gravar qualquer coisa. Se ele
entendeu errado, é só ignorar e mandar de novo.

## 2. Escolhe entrada ou saída

| | |
|---|---|
| ↗️ **Entrada** | dinheiro que chegou |
| ↘️ **Saída** | dinheiro que saiu |

Ao tocar no botão, o lançamento **já está gravado**. Nada se perde se você
parar aqui.

## 3. Responde o que foi — este é o passo que importa

| | |
|---|---|
| Saída | *"Qual foi o gasto?"* → mercado, farmácia, uber |
| Entrada | *"Qual a fonte do dinheiro?"* → salário, freela, presente |

Este passo é opcional, e é **o único que não dá para consertar depois**.

Um valor errado se resolve apagando a linha na planilha. Uma descrição não
preenchida some no instante em que a conversa rola para cima — e daqui a um mês
o extrato vira uma lista de números sem significado: você vê `200,00` e não faz
ideia se foi o mercado ou a farmácia.

São três segundos agora que valem o mês inteiro.

## Consultar

| Comando | O que mostra |
|---|---|
| `/saldo` | quanto entrou, saiu e sobrou no mês |
| `/extrato` | os últimos lançamentos, com o total |

No `/saldo` dá para navegar entre os meses pelos botões.

## Compartilhar no WhatsApp

O botão **📤 Compartilhar** abre o WhatsApp com o lançamento já escrito. Você
escolhe o grupo e confirma. Ele só fica completo — com a descrição junto — se
você tiver respondido o passo 3.

## Se algo der errado

- **O bot não responde nada** — seu número não está liberado. Manda qualquer
  mensagem para ele: ele devolve o seu ID, e quem administra libera.
- **"Não entendi isso como valor"** — manda só o número, sem texto junto.
- **"Não consegui falar com a planilha"** — foi falha temporária. Tenta de novo
  em instantes.
