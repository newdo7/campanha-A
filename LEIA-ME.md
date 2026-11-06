# Como publicar
1. Crie conta no Mercado Pago (mercadopago.com.br/developers) > Suas integrações > Criar aplicação > Credenciais.
   Teste: token que começa com TEST-. Produção: token APP_USR-.
2. Suba esta pasta no GitHub (o arquivo .env NÃO sobe).
3. Hospede em Render.com ou Railway (Node, comando: npm install && npm start). Adicione um disco persistente e aponte DATA_DIR para ele.
4. Em Environment, preencha as variáveis do .env.example (BASE_URL = endereço https do site).
5. Mercado Pago > Webhooks: URL = BASE_URL/api/webhook, evento "Pagamentos". Copie a chave secreta para MP_WEBHOOK_SECRET.
6. Painel: BASE_URL/admin.html
7. Para produção real: troque MP_ACCESS_TOKEN por APP_USR-... e cadastre sua chave Pix na conta Mercado Pago.

# Modo "Pix direto na minha chave" (sem gateway)
- Deixe MP_ACCESS_TOKEN vazio. No painel > Textos, preencha chave Pix (seu telefone), nome e cidade.
- O doador paga pelo QR/copia e cola e o dinheiro cai direto na sua conta.
- O site NÃO sabe quando você recebeu. No painel > Resumo, doações aparecem como "pendente": confira no app do banco e toque em "Recebi" para somar no total.


# Hospedagem 100% grátis (Render grátis + Supabase grátis)
1. supabase.com > New project. Em SQL Editor, cole o conteúdo de supabase.sql e rode.
2. Em Project Settings > API, copie a Project URL e a chave service_role (secreta, nunca divulgue).
3. No Render: plano Free, variáveis do .env.example (sem DATA_DIR e sem MP_ACCESS_TOKEN).
4. Para o site não "dormir": uptimerobot.com (grátis) > monitor HTTP no endereço BASE_URL/health a cada 5 minutos.
5. Limite de 50 MB por foto/vídeo enviado.
