const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const BASE = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(BASE, 'config_guardian.json'), 'utf8'));

const TIPOS = [
  { nome: 'Comportamento de Risco', arquivo: 'Guardian_Comportamento_Risco.xlsx' },
  { nome: 'Condição de Risco', arquivo: 'Guardian_Condicao_Risco.xlsx' },
  { nome: 'Incidente', arquivo: 'Guardian_Incidente.xlsx' },
  { nome: 'Reconhecimento', arquivo: 'Guardian_Reconhecimento.xlsx' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${m}`);

function pad2(n){ return String(n).padStart(2,'0'); }
function periodoAtual(){
  const d = new Date();
  return {
    inicio: `01/${pad2(d.getMonth()+1)}/${d.getFullYear()}`,
    fim: `${pad2(d.getDate())}/${pad2(d.getMonth()+1)}/${d.getFullYear()}`
  };
}
function ensureDir(p){ fs.mkdirSync(p,{recursive:true}); }

function esperarEnter(){
  return new Promise(resolve=>{
    process.stdin.resume();
    process.stdin.once('data',()=>resolve());
  });
}

async function esperarGuardian(page){
  log('Abrindo Gerenciamento de Registros...');
  await page.goto(CFG.guardian_url,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>{});

  try{
    await page.getByText('Gerenciamento de Registros',{exact:false}).first().waitFor({timeout:20000});
    log('Gerenciamento de Registros carregado.');
  }catch{
    console.log('');
    console.log('Se o Guardian pedir login, faça o login normalmente.');
    console.log('Quando estiver em "Gerenciamento de Registros", volte ao terminal e pressione ENTER.');
    await esperarEnter();
    await page.goto(CFG.guardian_url,{waitUntil:'domcontentloaded',timeout:45000});
    await page.getByText('Gerenciamento de Registros',{exact:false}).first().waitFor({timeout:30000});
    log('Gerenciamento de Registros carregado após login.');
  }

  await esperarFiltros(page);
}

async function esperarFiltros(page){
  log('Aguardando os filtros do Guardian carregarem...');

  const possiveis = [
    'nz-select-top-control[aria-label="Período de tempo requerido"]',
    '[aria-label="Período de tempo requerido"]',
    '#searchDateRange',
    'nz-range-picker#searchDateRange'
  ];

  const limite = Date.now() + 45000;
  while(Date.now() < limite){
    for(const s of possiveis){
      const loc = page.locator(s).first();
      if(await loc.count()){
        const vis = await loc.isVisible().catch(()=>false);
        if(vis){
          log('Filtros carregados.');
          return;
        }
      }
    }
    await sleep(800);
  }
  throw new Error('Os filtros do Gerenciamento de Registros não carregaram dentro de 45 segundos.');
}

async function abrirDownloads(page){
  await page.goto(CFG.downloads_url || 'https://guardian.ab-inbev.com/downloads',{
    waitUntil:'domcontentloaded', timeout:45000
  }).catch(()=>{});
  await sleep(1200);
}

async function infoUltimaLinha(page,item,p){
  await abrirDownloads(page);

  const rows = page.locator('tr').filter({hasText:item.nome});
  const n = await rows.count();
  if(!n) return {row:null,count:0,text:''};

  // Procura primeiro uma linha do tipo que também contenha a data final atual.
  for(let i=n-1;i>=0;i--){
    const r = rows.nth(i);
    const txt = (await r.innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();
    if(txt.includes(p.fim)){
      return {row:r,count:n,text:txt};
    }
  }

  const r = rows.nth(n-1);
  const txt = (await r.innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();
  return {row:r,count:n,text:txt};
}

async function linhaExiste(page,item,p){
  const info=await infoUltimaLinha(page,item,p);
  if(!info.row) return false;

  // Só considera atual se a linha trouxer a data final de hoje.
  if(!info.text.includes(p.fim)) return false;

  log(`Já existe pedido atual de ${item.nome}.`);
  return true;
}

async function limparFiltros(page){
  const b = page.getByRole('button',{name:/Limpar filtros/i}).first();
  if(await b.count()){
    if(await b.isEnabled().catch(()=>false)){
      await b.click({timeout:8000}).catch(()=>{});
      await sleep(700);
    }
  }
}

async function selecionarPeriodo(page){
  log('Selecionando "Data em que o fato ocorreu"...');
  await esperarFiltros(page);

  // Estrutura real vista no Guardian:
  // nz-select-top-control aria-label="Período de tempo requerido"
  let controle = page.locator('nz-select-top-control[aria-label="Período de tempo requerido"]').first();

  if(!(await controle.count())){
    controle = page.locator('[aria-label="Período de tempo requerido"]').first();
  }

  // Fallback pelo item selecionado.
  if(!(await controle.count())){
    const itemAtual = page.locator('nz-select-item[title="Data em que o fato ocorreu"]').first();
    if(await itemAtual.count()){
      log('O período requerido já está em "Data em que o fato ocorreu".');
      return;
    }
  }

  if(!(await controle.count())){
    throw new Error('Não encontrei o campo "Período de tempo requerido" mesmo após aguardar o carregamento.');
  }

  const textoAtual = (await controle.innerText().catch(()=>'' )).trim();
  if(/Data em que o fato ocorreu/i.test(textoAtual)){
    log('O período requerido já está correto.');
    return;
  }

  await controle.click({timeout:10000});
  await sleep(500);

  let opt = page.locator('nz-option-item[title="Data em que o fato ocorreu"]').last();
  if(!(await opt.count())) opt = page.locator('.ant-select-item-option[title="Data em que o fato ocorreu"]').last();
  if(!(await opt.count())) opt = page.getByText('Data em que o fato ocorreu',{exact:true}).last();

  if(!(await opt.count())){
    throw new Error('Abri o período requerido, mas não encontrei a opção "Data em que o fato ocorreu".');
  }

  await opt.click({timeout:10000});
  await sleep(600);
  log('Período requerido selecionado.');
}

async function setData(input,valor,nome){
  await input.waitFor({state:'visible',timeout:15000});
  await input.click({timeout:8000});
  await input.press('Control+A');
  await input.type(valor,{delay:30});
  await input.press('Tab');
  await sleep(300);

  const atual=await input.inputValue().catch(()=> '');
  if(atual!==valor){
    await input.evaluate((el,v)=>{
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(el,v);
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      el.dispatchEvent(new Event('blur',{bubbles:true}));
    },valor);
    await sleep(350);
  }
  log(`${nome}: ${valor}`);
}

async function preencherDatas(page,p){
  log('Preenchendo período...');
  await esperarFiltros(page);

  let ini = page.locator('#searchDateRange input[placeholder="Data inicial"]').first();
  let fim = page.locator('#searchDateRange input[placeholder="Data final"]').first();

  if(!(await ini.count())) ini=page.locator('input[placeholder="Data inicial"]').first();
  if(!(await fim.count())) fim=page.locator('input[placeholder="Data final"]').first();

  if(!(await ini.count()) || !(await fim.count())){
    throw new Error('Não encontrei os campos Data inicial/Data final.');
  }

  await setData(ini,p.inicio,'Data inicial');
  await setData(fim,p.fim,'Data final');
}

async function selecionarTipo(page,tipo){
  log(`Selecionando tipo: ${tipo}`);

  let sel=page.locator('[data-testid="register-type-multi-select-component"]').first();
  if(!(await sel.count())) sel=page.locator('nz-select[aria-label="Tipo de registro"]').first();
  if(!(await sel.count())) sel=page.locator('[aria-label="Tipo de registro"]').first();

  if(!(await sel.count())) throw new Error('Não encontrei o campo "Tipo de registro".');

  const atual=(await sel.innerText().catch(()=>'' )).trim();
  if(atual.includes(tipo)){
    log(`Tipo já selecionado: ${tipo}`);
    return;
  }

  await sel.click({timeout:10000});
  await sleep(450);

  let opt=page.locator(`nz-option-item[title="${tipo}"]`).last();
  if(!(await opt.count())) opt=page.locator(`.ant-select-item-option[title="${tipo}"]`).last();
  if(!(await opt.count())) opt=page.getByText(tipo,{exact:true}).last();

  if(!(await opt.count())) throw new Error(`Não encontrei a opção "${tipo}".`);

  await opt.click({timeout:10000});
  await sleep(550);
}

async function prepararEBuscar(page,item,p){
  await page.goto(CFG.guardian_url,{waitUntil:'domcontentloaded',timeout:45000});
  await page.getByText('Gerenciamento de Registros',{exact:false}).first().waitFor({timeout:20000});
  await esperarFiltros(page);

  await limparFiltros(page);
  await selecionarPeriodo(page);
  await preencherDatas(page,p);
  await selecionarTipo(page,item.nome);

  const buscar=page.getByRole('button',{name:/Buscar registros/i}).first();
  if(!(await buscar.count())) throw new Error('Botão "Buscar registros" não encontrado.');

  await buscar.click({timeout:10000});
  log(`Busca feita: ${item.nome}`);

  const exportar=page.getByRole('button',{name:/Exportar relatório/i}).first();
  if(!(await exportar.count())) throw new Error('Botão "Exportar relatório" não encontrado.');

  const limite=Date.now()+60000;
  while(Date.now()<limite){
    if(await exportar.isEnabled().catch(()=>false)) break;
    await sleep(1000);
  }

  if(!(await exportar.isEnabled().catch(()=>false))){
    throw new Error(`O botão "Exportar relatório" não habilitou para ${item.nome}.`);
  }

  await sleep(1800);
  await exportar.click({timeout:10000});
  log(`Exportação solicitada: ${item.nome}`);
}

async function aguardarPedidoAparecer(page,item,p,segundos=45){
  const limite=Date.now()+segundos*1000;
  while(Date.now()<limite){
    const info=await infoUltimaLinha(page,item,p);
    if(info.row && info.text.includes(p.fim)){
      log(`Pedido apareceu em Downloads: ${item.nome}.`);
      return true;
    }
    await sleep(4000);
  }
  return false;
}

async function garantirPedido(page,item,p){
  if(await linhaExiste(page,item,p)) return;

  for(let tentativa=1; tentativa<=2; tentativa++){
    log(`Não existe pedido atual de ${item.nome}. Tentativa ${tentativa}/2.`);
    await prepararEBuscar(page,item,p);

    if(await aguardarPedidoAparecer(page,item,p,45)) return;

    log(`O pedido de ${item.nome} ainda não apareceu em Downloads.`);
    if(tentativa<2){
      log(`Vou repetir somente ${item.nome}.`);
      await sleep(2500);
    }
  }

  throw new Error(`O Guardian não criou o pedido de ${item.nome} em Downloads após 2 tentativas.`);
}

async function esperarPronto(page,item,p){
  log(`Aguardando ${item.nome} ficar pronto...`);
  const limite=Date.now()+(CFG.download_wait_ms || 360000);

  while(Date.now()<limite){
    const info=await infoUltimaLinha(page,item,p);
    if(info.row && info.text.includes(p.fim)){
      if(/Pronto para download/i.test(info.text)){
        log(`${item.nome} está pronto.`);
        return info.row;
      }
      if(/Falha|Erro/i.test(info.text)){
        throw new Error(`Guardian informou falha em ${item.nome}: ${info.text}`);
      }
    }
    await sleep(5000);
  }

  throw new Error(`Tempo esgotado esperando ${item.nome}.`);
}

async function baixar(page,row,item){
  ensureDir(CFG.output_dir);
  const destino=path.join(CFG.output_dir,item.arquivo);

  if(fs.existsSync(destino)){
    fs.renameSync(destino,destino.replace(/\.xlsx$/i,`.anterior_${Date.now()}.xlsx`));
  }

  let icon=row.locator('span.icon-wrapper.icon-clickable').first();
  if(!(await icon.count())) icon=row.locator('[class*="icon-clickable"]').first();

  if(!(await icon.count())){
    throw new Error(`Ícone de download não encontrado para ${item.nome}.`);
  }

  const dlPromise=page.waitForEvent('download',{timeout:60000});
  await icon.click({timeout:10000});
  const dl=await dlPromise;
  await dl.saveAs(destino);

  const tamanho=fs.statSync(destino).size;
  if(tamanho<1000) throw new Error(`Arquivo inválido: ${item.arquivo}`);

  log(`Baixado: ${item.arquivo} (${(tamanho/1024).toFixed(1)} KB)`);
}




async function liberarPortalSeguranca(pagina){
  // O carrossel pode aparecer com atraso, depois que a página já carregou.
  // Por isso esperamos um pouco antes de concluir que ele está fechado.
  await sleep(1200);

  const overlay = pagina.locator('#matinalOverlay').first();

  if(!(await overlay.count())){
    log('Carrossel da Matinal não encontrado. Seguindo...');
    return;
  }

  const aberto = async ()=>{
    const visivel = await overlay.isVisible().catch(()=>false);
    const classe = (await overlay.getAttribute('class').catch(()=>'')) || '';
    return visivel || /\bopen\b/i.test(classe);
  };

  if(!(await aberto())){
    // Dá mais uma pequena janela para o carrossel automático aparecer.
    await sleep(1200);
    if(!(await aberto())){
      log('Carrossel já está fechado.');
      return;
    }
  }

  log('Carrossel da Matinal aberto. Fechando...');

  // 1) Tenta o botão "Entrar no Portal" usando click DOM,
  // para não depender de actionability/pointer-events.
  const entrar = pagina.locator('#matinalEnter').first();
  if(await entrar.count()){
    await entrar.evaluate(el => el.click()).catch(()=>{});
    await sleep(700);
  }

  // 2) Se ainda estiver aberto, tenta o X.
  if(await aberto()){
    const fechar = pagina.locator('#matinalCloseX').first();
    if(await fechar.count()){
      await fechar.evaluate(el => el.click()).catch(()=>{});
      await sleep(700);
    }
  }

  // 3) Último fallback: como o Portal é nosso, remove a camada diretamente.
  // Isso evita que o carrossel intercepte os cliques da automação.
  if(await aberto()){
    log('Carrossel ainda está ativo. Removendo a camada de bloqueio...');
    await pagina.evaluate(()=>{
      const o = document.getElementById('matinalOverlay');
      if(o){
        o.classList.remove('open');
        o.style.display = 'none';
        o.style.visibility = 'hidden';
        o.style.pointerEvents = 'none';
        o.setAttribute('aria-hidden','true');
      }
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    }).catch(()=>{});
    await sleep(400);
  }

  if(await aberto()){
    throw new Error('Não foi possível remover o carrossel da Matinal de Segurança.');
  }

  log('Carrossel fechado.');
}

async function irParaAtualizarDados(pagina){
  log('Abrindo a página "Atualizar dados"...');

  const aba = pagina.locator('button.tab[data-view="update"]').first();
  if(!(await aba.count())){
    throw new Error('A aba "Atualizar dados" não foi encontrada no Portal Segurança.');
  }

  await aba.scrollIntoViewIfNeeded();
  await aba.click({ timeout:15000 });

  const secao = pagina.locator('section#update').first();
  await secao.waitFor({ state:'visible', timeout:15000 });

  log('Página "Atualizar dados" aberta.');
  await liberarPortalSeguranca(pagina);
}
async function atualizarPortalSeguranca(context){
  if(!CFG.portal_enabled){
    log('Atualização automática do Portal Segurança está desativada.');
    return;
  }

  const indexPath = CFG.portal_index_path;
  if(!fs.existsSync(indexPath)){
    throw new Error(`Index do Portal Segurança não encontrado: ${indexPath}`);
  }

  const arquivos = {
    comportamento: path.join(CFG.output_dir,'Guardian_Comportamento_Risco.xlsx'),
    condicao: path.join(CFG.output_dir,'Guardian_Condicao_Risco.xlsx'),
    incidente: path.join(CFG.output_dir,'Guardian_Incidente.xlsx'),
    reconhecimento: path.join(CFG.output_dir,'Guardian_Reconhecimento.xlsx')
  };

  for(const [nome,arquivo] of Object.entries(arquivos)){
    if(!fs.existsSync(arquivo)){
      throw new Error(`Relatório ausente para atualizar o Portal (${nome}): ${arquivo}`);
    }
    const tamanho = fs.statSync(arquivo).size;
    if(tamanho < 1000){
      throw new Error(`Relatório inválido para atualizar o Portal (${nome}): ${arquivo}`);
    }
  }

  log('');
  log('===== ATUALIZANDO PORTAL SEGURANÇA =====');
  log(`Index: ${indexPath}`);
  log(`Relatórios: ${CFG.output_dir}`);

  const pagina = await context.newPage();
  await pagina.goto(pathToFileURL(indexPath).href,{
    waitUntil:'domcontentloaded',
    timeout:60000
  });

  await liberarPortalSeguranca(pagina);
  await irParaAtualizarDados(pagina);

  const mapaInputs = [
    ['#fileAct', arquivos.comportamento, 'Ato inseguro / Comportamento de Risco'],
    ['#fileIncident', arquivos.incidente, 'Incidente'],
    ['#fileRecognition', arquivos.reconhecimento, 'Reconhecimento'],
    ['#fileCondition', arquivos.condicao, 'Condição insegura / Condição de Risco']
  ];

  for(const [seletor,arquivo,nome] of mapaInputs){
    const input = pagina.locator(seletor).first();
    if(!(await input.count())){
      throw new Error(`O Portal Segurança não possui o campo ${seletor} (${nome}).`);
    }
    await input.setInputFiles(arquivo);
    log(`Relatório carregado no Portal: ${nome}`);
  }

  const processar = pagina.locator('#processUploads').first();
  if(!(await processar.count())){
    throw new Error('Botão #processUploads não encontrado no Portal Segurança.');
  }

  await liberarPortalSeguranca(pagina);
  await processar.scrollIntoViewIfNeeded();
  await processar.waitFor({ state:'visible', timeout:15000 });
  await processar.evaluate(el => el.click());
  log('Clique em "Ler relatórios e atualizar" realizado. Aguardando processamento...');

  const status = pagina.locator('#uploadStatus').first();
  if(await status.count()){
    const limite = Date.now()+120000;
    let concluido=false;

    while(Date.now()<limite){
      const texto = (await status.innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();
      if(/conclu[ií]d|sucesso|finaliz/i.test(texto)){
        concluido=true;
        log(`Portal confirmou processamento: ${texto || 'concluído'}`);
        break;
      }
      if(/erro|falha/i.test(texto)){
        throw new Error(`Portal informou erro ao processar relatórios: ${texto}`);
      }
      await sleep(1000);
    }

    if(!concluido){
      throw new Error('Tempo esgotado aguardando o Portal processar os quatro relatórios.');
    }
  }else{
    log('Campo de status não encontrado; aguardando 8 segundos antes de gerar o novo Index.');
    await sleep(8000);
  }

  await irParaAtualizarDados(pagina);

  const gerar = pagina.locator('#generateIndex').first();
  if(!(await gerar.count())){
    throw new Error('Botão #generateIndex não encontrado no Portal Segurança.');
  }

  ensureDir(CFG.portal_backup_dir);

  await liberarPortalSeguranca(pagina);
  log('Gerando novo Index atualizado...');
  const eventoDownload = pagina.waitForEvent('download',{timeout:60000});
  await gerar.scrollIntoViewIfNeeded();
  await gerar.evaluate(el => el.click());
  const download = await eventoDownload;

  const temp = path.join(path.dirname(indexPath),`__index_novo_${Date.now()}.html`);
  await download.saveAs(temp);

  if(!fs.existsSync(temp) || fs.statSync(temp).size < 10000){
    throw new Error('O novo Index gerado pelo Portal parece inválido.');
  }

  const agora = new Date();
  const carimbo =
    agora.getFullYear() +
    String(agora.getMonth()+1).padStart(2,'0') +
    String(agora.getDate()).padStart(2,'0') + '_' +
    String(agora.getHours()).padStart(2,'0') +
    String(agora.getMinutes()).padStart(2,'0') +
    String(agora.getSeconds()).padStart(2,'0');

  const backup = path.join(
    CFG.portal_backup_dir,
    `index_seguranca_504_BACKUP_${carimbo}.html`
  );

  fs.copyFileSync(indexPath,backup);
  fs.copyFileSync(temp,indexPath);
  fs.unlinkSync(temp);

  log(`Backup criado: ${backup}`);
  log('Index novo gerado com sucesso.');
  log('Index antigo substituído mantendo o nome: index_seguranca_504.html');
  await pagina.close();
}

async function main(){
  const p=periodoAtual();
  ensureDir(CFG.output_dir);
  ensureDir(CFG.chrome_profile_dir);

  console.log('============================================================');
  console.log(' GUARDIAN 504 - V2.5.1 FINAL');
  console.log(' Guardian > 4 Relatorios > Portal Seguranca > Novo Index');
  console.log('============================================================');
  log(`Período: ${p.inicio} até ${p.fim}`);

  const context=await chromium.launchPersistentContext(CFG.chrome_profile_dir,{
    channel:'chrome',
    headless:false,
    acceptDownloads:true,
    viewport:null,
    chromiumSandbox:true,
    args:['--start-maximized']
  });

  const page=context.pages()[0] || await context.newPage();

  try{
    await esperarGuardian(page);

    for(const item of TIPOS){
      log('');
      log(`===== VALIDANDO ${item.nome} =====`);
      await garantirPedido(page,item,p);
    }

    for(const item of TIPOS){
      log('');
      log(`===== BAIXANDO ${item.nome} =====`);
      const row=await esperarPronto(page,item,p);
      await baixar(page,row,item);
    }

    log('');
    log('=== SUCESSO: 4 RELATÓRIOS BAIXADOS ===');
    log(`Pasta: ${CFG.output_dir}`);

    await atualizarPortalSeguranca(context);

    log('');
    log('=== PROCESSO CONCLUÍDO ===');
    log('Guardian atualizado e Portal Segurança regenerado.');
    console.log('Pressione ENTER para fechar.');
    await esperarEnter();

  }catch(e){
    console.error('');
    console.error('=== FALHA ===');
    console.error(e && e.stack ? e.stack : e);
    console.error('');
    console.error('Pressione ENTER para encerrar.');
    await esperarEnter();
  }finally{
    await context.close().catch(()=>{});
  }
}

main();
