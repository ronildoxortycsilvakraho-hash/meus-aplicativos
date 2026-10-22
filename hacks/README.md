# QuebraCode

QuebraCode é um laboratório educativo de lógica e segurança digital. O jogo solo, o solucionador, o guia, os cenários fictícios, a análise local de links e o catálogo de ameaças funcionam sem conta. As contas e partidas pela internet usam Firebase Authentication, Cloud Firestore e Cloud Functions.

## Executar as funções locais

Abra `index.html` no navegador para usar as funções locais. Login e cadastro online exigem HTTPS (ou `localhost`) e a configuração do Firebase em `FIREBASE_CONFIG`, no módulo JavaScript de `index.html`.

## Configurar o Firebase

1. Crie um projeto Firebase e um aplicativo Web no Console Firebase. Em **Authentication → Sign-in method**, habilite **E-mail/senha**.
2. Crie um banco Cloud Firestore na região desejada. As Cloud Functions desta configuração usam `southamerica-east1`; mantenha banco e funções em regiões compatíveis.
3. Instale o Firebase CLI, entre na sua conta e associe esta pasta ao projeto:

   ```powershell
   npm install -g firebase-tools
   firebase login
   firebase use --add
   ```

4. O projeto padrão já está definido como `project-2133645727` em `.firebaserc`, e seu `projectId` e `authDomain` já estão preenchidos em `FIREBASE_CONFIG` no `index.html`. No Console Firebase, registre um aplicativo Web nesse projeto e copie os valores `apiKey` e `appId` para completar a configuração. Esses valores do app Web são públicos.
5. Instale as dependências das funções e implante as regras, funções e hospedagem:

   ```powershell
   cd functions
   npm install
   cd ..
   firebase deploy --only firestore:rules,functions,hosting
   ```

   A implantação das Cloud Functions pode exigir que o projeto esteja no plano Blaze e que o faturamento esteja habilitado. Revise custos, limites e região no Console Google Cloud antes de implantar.
6. Em **Authentication → Settings → Authorized domains**, confirme que o domínio HTTPS de hospedagem está autorizado. Publique e abra a URL HTTPS, crie uma conta e confirme o e-mail. Compartilhe o código de sala de 10 caracteres para convidar outros jogadores.

## Regras da partida online

- Até 6 participantes por sala; o anfitrião inicia quando houver pelo menos 2.
- A sequência contém 4 dígitos diferentes; a equipe tem até 8 palpites compartilhados.
- Apelidos, palpites e pistas são sincronizados ao vivo pelo Firestore.
- A sequência fica em `roomSecrets`, inacessível pelas regras do Firestore. Apenas as Cloud Functions podem ler ou alterar esse documento; a sala pública só recebe a sequência depois do fim.
- Operações de criar/entrar/iniciar/enviar palpite são executadas por Cloud Functions autenticadas, nunca por gravações diretas do navegador.
- O jogo online usa salas e regras próprias; não sincroniza o progresso do modo solo.

As regras em [`firestore.rules`](./firestore.rules) negam escritas do cliente e limitam leituras a membros da sala. Não conceda acesso público ao Firestore, não remova as regras de `roomSecrets` e nunca publique credenciais de conta de serviço. A configuração Web Firebase não é um segredo; a segurança depende de Authentication, regras e validações do servidor.

Sem configuração Firebase, as telas de login e partidas informam que estão indisponíveis; não simulam uma conexão.
