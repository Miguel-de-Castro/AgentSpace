# Landing page

Página estática (HTML + CSS puros, sem build, sem dependências) que apresenta o AgentSpace. O app em si roda só localmente; veja "Como rodar" na própria página ou no README da raiz.

## Ver localmente

```bash
npx serve landing
# ou: python -m http.server 8000 --directory landing
```

## Deploy na Vercel

1. Importe o repositório na Vercel.
2. Em **Root Directory**, escolha `landing`.
3. **Framework Preset**: Other. Deixe o build command e o output directory vazios.

`landing/vercel.json` já define `cleanUrls` e os headers de segurança (CSP restrita, sem scripts ou estilos inline).

Depois do primeiro deploy, se quiser usar o domínio final no cartão de compartilhamento, troque a URL de `og:image` em `index.html`. Hoje ela aponta para o arquivo no GitHub (`raw.githubusercontent.com`), que passa a funcionar após o merge na `main`.
