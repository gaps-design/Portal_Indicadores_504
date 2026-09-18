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

// Dentro desta janela, um pedido correto já existente é reaproveitado.
// Isso evita gerar de novo Comportamento/Condição/Incidente quando,
// por exemplo, só Reconhecimento ficou faltando na tentativa anterior.
const REUSO_MINUTOS = Number(CFG.reuse_window_minutes || 30);

const EXECUTADO_PELA_CENTRAL = process.env.PORTAL504_CENTRAL === '1';

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

function tiposNaLinha(texto){
  const normalizado=(texto || '').replace(/\s+/g,' ').trim();
  return TIPOS
    .map(x=>x.nome)
    .filter(nome=>normalizado.includes(nome));
}

function linhaEhDoTipoExato(texto,item){
  const encontrados=tiposNaLinha(texto);
  return encontrados.length===1 && encontrados[0]===item.nome;
}

function linhaTemLocalidadeCorreta(texto){
  // O Guardian não expõe "Local do evento = Dentro unidade" de forma confiável
  // na tabela de Downloads. Portanto a validação da localidade é feita
  // imediatamente antes da exportação, na tela de filtros.
  return true;
}

function extrairDataSolicitacao(texto){
  // Pega o primeiro DD/MM/AAAA HH:MM da linha, que é "Data da solicitação".
  const m=(texto || '').match(/\b(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})\b/);
  if(!m) return null;

  const d=new Date(
    Number(m[3]),
    Number(m[2])-1,
    Number(m[1]),
    Number(m[4]),
    Number(m[5]),
    0,
    0
  );

  return Number.isNaN(d.getTime()) ? null : d;
}

function idadeMinutos(data){
  if(!data) return Infinity;
  return Math.max(0,(Date.now()-data.getTime())/60000);
}

function statusPedido(texto){
  if(/Pronto para download/i.test(texto || '')) return 'pronto';
  if(/Falha|Erro/i.test(texto || '')) return 'erro';
  return 'processando';
}

async function listarLinhasValidasAtuais(page,item,p){
  await abrirDownloads(page);

  const candidatas=page.locator('tr').filter({hasText:item.nome});
  const n=await candidatas.count();
  const validas=[];

  for(let i=0;i<n;i++){
    const row=candidatas.nth(i);
    const texto=(await row.innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();

    // O pedido só é considerado correto se tiver:
    // - período deste mês até hoje
    // - tipo EXATO (sem "Incidente, Reconhecimento", etc.)
    // - Local do evento é aplicado na geração como Dentro unidade
    if(!texto.includes(p.inicio) || !texto.includes(p.fim)) continue;
    if(!linhaEhDoTipoExato(texto,item)) continue;
    if(!linhaTemLocalidadeCorreta(texto)) continue;

    const dataSolicitacao=extrairDataSolicitacao(texto);

    validas.push({
      row,
      texto,
      dataSolicitacao,
      status:statusPedido(texto),
      idadeMin:idadeMinutos(dataSolicitacao)
    });
  }

  // Mais recente primeiro. Se não conseguirmos ler o horário,
  // essa linha fica por último e não ganha prioridade.
  validas.sort((a,b)=>{
    const ta=a.dataSolicitacao ? a.dataSolicitacao.getTime() : 0;
    const tb=b.dataSolicitacao ? b.dataSolicitacao.getTime() : 0;
    return tb-ta;
  });

  return validas;
}

async function infoUltimaLinha(page,item,p){
  const validas=await listarLinhasValidasAtuais(page,item,p);

  if(!validas.length){
    return {
      row:null,
      count:0,
      text:'',
      dataSolicitacao:null,
      status:null,
      idadeMin:Infinity
    };
  }

  const v=validas[0];
  return {
    row:v.row,
    count:validas.length,
    text:v.texto,
    dataSolicitacao:v.dataSolicitacao,
    status:v.status,
    idadeMin:v.idadeMin
  };
}

async function infoPedidoRecente(page,item,p){
  const info=await infoUltimaLinha(page,item,p);

  if(!info.row) return null;
  if(!Number.isFinite(info.idadeMin)) return null;

  // Pedido com erro não é reaproveitado.
  if(info.status==='erro') return null;

  if(info.idadeMin<=REUSO_MINUTOS){
    return info;
  }

  return null;
}

async function contarPedidosValidosAtuais(page,item,p){
  const validas=await listarLinhasValidasAtuais(page,item,p);
  return validas.length;
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

async function localizarCampoTipo(page){
  let sel=page.locator('[data-testid="register-type-multi-select-component"]').first();
  if(!(await sel.count())) sel=page.locator('nz-select[aria-label="Tipo de registro"]').first();
  if(!(await sel.count())) sel=page.locator('[aria-label="Tipo de registro"]').first();

  if(!(await sel.count())){
    throw new Error('Não encontrei o campo "Tipo de registro".');
  }

  return sel;
}

function nomesConhecidosNoTexto(texto){
  const normalizado=(texto || '').replace(/\s+/g,' ').trim();
  return TIPOS.map(x=>x.nome).filter(nome=>normalizado.includes(nome));
}

async function selecionadosNoCampo(sel){
  const txt=await sel.innerText().catch(()=> '');
  return nomesConhecidosNoTexto(txt);
}

async function selecionadosNoDropdown(page){
  const locators=[
    '.cdk-overlay-container nz-option-item.ant-select-item-option-selected:visible',
    '.cdk-overlay-container .ant-select-item-option-selected:visible',
    '.ant-select-dropdown:visible nz-option-item.ant-select-item-option-selected',
    '.ant-select-dropdown:visible .ant-select-item-option-selected'
  ];

  for(const s of locators){
    const opts=page.locator(s);
    const n=await opts.count().catch(()=>0);

    if(!n) continue;

    const nomes=[];
    for(let i=0;i<n;i++){
      const txt=(await opts.nth(i).innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();
      for(const item of TIPOS){
        if(txt===item.nome || txt.includes(item.nome)){
          if(!nomes.includes(item.nome)) nomes.push(item.nome);
        }
      }
    }
    return {locator:opts,nomes};
  }

  return {locator:null,nomes:[]};
}

async function limparSelecoesTipo(page){
  const sel=await localizarCampoTipo(page);
  log('Limpando completamente o filtro "Tipo de registro"...');

  // Abre o multi-select para enxergar as opções realmente marcadas.
  await sel.click({timeout:10000});
  await sleep(450);

  // 1) Desmarca diretamente TODAS as opções que o Guardian mantém selecionadas.
  for(let rodada=0;rodada<10;rodada++){
    const info=await selecionadosNoDropdown(page);

    if(!info.nomes.length) break;

    log(`Desmarcando: ${info.nomes.join(', ')}`);

    // Reconsulta a cada clique porque o DOM do dropdown muda ao desmarcar.
    const nome=info.nomes[0];

    let opt=page.locator(
      `.cdk-overlay-container nz-option-item.ant-select-item-option-selected[title="${nome}"]:visible`
    ).last();

    if(!(await opt.count())){
      opt=page.locator(
        `.cdk-overlay-container .ant-select-item-option-selected[title="${nome}"]:visible`
      ).last();
    }

    if(!(await opt.count())){
      opt=page.getByText(nome,{exact:true}).filter({visible:true}).last();
    }

    if(await opt.count()){
      await opt.click({timeout:8000,force:true}).catch(()=>{});
      await sleep(350);
    }else{
      break;
    }
  }

  await page.keyboard.press('Escape').catch(()=>{});
  await sleep(250);

  // 2) Se ainda houver chips no campo, tenta remover pelo X.
  for(let rodada=0;rodada<10;rodada++){
    const restantes=await selecionadosNoCampo(sel);
    if(!restantes.length) break;

    const remover=sel.locator(
      '.ant-select-selection-item-remove, nz-select-item .anticon-close, nz-select-item [nztype="close"]'
    ).first();

    if(await remover.count() && await remover.isVisible().catch(()=>false)){
      await remover.click({timeout:5000,force:true}).catch(()=>{});
      await sleep(250);
      continue;
    }

    // 3) Último fallback para Ant Design multi-select: Backspace remove último chip.
    await sel.click({timeout:5000}).catch(()=>{});
    await page.keyboard.press('End').catch(()=>{});
    await page.keyboard.press('Backspace').catch(()=>{});
    await sleep(250);
    await page.keyboard.press('Escape').catch(()=>{});
  }

  const restantes=await selecionadosNoCampo(sel);

  if(restantes.length){
    throw new Error(
      `Não consegui limpar "Tipo de registro". Ainda selecionado(s): ${restantes.join(', ')}`
    );
  }

  log('Filtro "Tipo de registro" zerado.');
}

async function selecionarTipo(page,tipo){
  await limparSelecoesTipo(page);

  log(`Selecionando SOMENTE: ${tipo}`);
  const sel=await localizarCampoTipo(page);

  await sel.click({timeout:10000});
  await sleep(450);

  let opt=page.locator(`.cdk-overlay-container nz-option-item[title="${tipo}"]:visible`).last();
  if(!(await opt.count())) opt=page.locator(`.cdk-overlay-container .ant-select-item-option[title="${tipo}"]:visible`).last();
  if(!(await opt.count())) opt=page.locator(`nz-option-item[title="${tipo}"]`).last();
  if(!(await opt.count())) opt=page.locator(`.ant-select-item-option[title="${tipo}"]`).last();
  if(!(await opt.count())) opt=page.getByText(tipo,{exact:true}).last();

  if(!(await opt.count())){
    throw new Error(`Não encontrei a opção "${tipo}".`);
  }

  await opt.click({timeout:10000});
  await sleep(500);

  // Validação real no dropdown: só uma opção conhecida pode estar selecionada.
  const real=await selecionadosNoDropdown(page);
  await page.keyboard.press('Escape').catch(()=>{});
  await sleep(250);

  let selecionados=real.nomes;

  // Fallback pela renderização dos chips do campo.
  if(!selecionados.length){
    selecionados=await selecionadosNoCampo(sel);
  }

  if(selecionados.length!==1 || selecionados[0]!==tipo){
    throw new Error(
      `Filtro inválido antes da busca. Esperado SOMENTE "${tipo}", mas o Guardian mostra: ` +
      (selecionados.length ? selecionados.join(', ') : 'nenhum tipo')
    );
  }

  log(`Filtro confirmado: SOMENTE "${tipo}".`);
}


async function localizarCampoLocalEvento(page){
  const candidatos=[
    'input[placeholder="Local do evento"]',
    '[placeholder="Local do evento"]',
    '[aria-label="Local do evento"]',
    '[data-testid*="event" i] input',
    '[data-testid*="local" i] input'
  ];

  for(const s of candidatos){
    const loc=page.locator(s).first();
    if(await loc.count() && await loc.isVisible().catch(()=>false)){
      return loc;
    }
  }

  throw new Error('Não encontrei o campo "Local do evento".');
}

async function selecionarLocalEvento(page){
  const valor='Dentro unidade';
  log(`Selecionando Local do evento: ${valor}`);

  const campo=await localizarCampoLocalEvento(page);

  const atual=(
    (await campo.inputValue().catch(()=>'')) ||
    (await campo.innerText().catch(()=>''))
  ).replace(/\s+/g,' ').trim();

  if(/Dentro unidade/i.test(atual)){
    log('Local do evento já está correto: Dentro unidade');
    return;
  }

  await campo.click({timeout:10000});
  await sleep(450);

  let opt=page.getByText(valor,{exact:true}).last();

  if(!(await opt.count())){
    opt=page.locator('.ant-select-item-option, [role="option"], li, div')
      .filter({hasText:/^\s*Dentro unidade\s*$/i})
      .last();
  }

  if(!(await opt.count())){
    throw new Error('Não encontrei a opção "Dentro unidade" em "Local do evento".');
  }

  await opt.click({timeout:10000});
  await sleep(900);

  const depois=(
    (await campo.inputValue().catch(()=>'')) ||
    (await campo.innerText().catch(()=>''))
  ).replace(/\s+/g,' ').trim();

  // Alguns componentes limpam o texto do input depois da escolha,
  // então também aceitamos a presença da opção selecionada visível na região do campo.
  if(depois && !/Dentro unidade/i.test(depois)){
    const visivel=page.getByText('Dentro unidade',{exact:true}).first();
    if(!(await visivel.count())){
      throw new Error(
        `O campo "Local do evento" não confirmou "Dentro unidade". Valor atual: "${depois}".`
      );
    }
  }

  log('Local do evento confirmado: Dentro unidade');
}

async function selecionarLocalidade(page){
  // Regra correta confirmada no Guardian:
  // Local do evento = Dentro unidade
  // Não há filtro adicional de Unidade/Jacarei.
  await selecionarLocalEvento(page);
  log('Filtro de localidade validado: Dentro unidade.');
}

async function prepararEBuscar(page,item,p){
  await page.goto(CFG.guardian_url,{waitUntil:'domcontentloaded',timeout:45000});
  await page.getByText('Gerenciamento de Registros',{exact:false}).first().waitFor({timeout:20000});
  await esperarFiltros(page);

  await limparFiltros(page);
  await selecionarPeriodo(page);
  await preencherDatas(page,p);
  await selecionarLocalidade(page);
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

  // Confirma novamente os filtros imediatamente antes de exportar.
  // Se o Guardian tiver limpado algum campo após "Buscar registros",
  // paramos em vez de gerar um relatório incorreto.
  const selTipo=await localizarCampoTipo(page);
  const tiposConfirmados=await selecionadosNoCampo(selTipo);

  if(tiposConfirmados.length!==1 || tiposConfirmados[0]!==item.nome){
    throw new Error(
      `Filtro mudou após a busca. Esperado somente "${item.nome}", encontrado: ` +
      (tiposConfirmados.length ? tiposConfirmados.join(', ') : 'nenhum tipo')
    );
  }

  const localEvento=await localizarCampoLocalEvento(page);

  const localTxt=(
    (await localEvento.inputValue().catch(()=>'')) ||
    (await localEvento.innerText().catch(()=>''))
  ).replace(/\s+/g,' ').trim();

  // Confirma novamente o filtro imediatamente antes de exportar.
  // Se o componente não mantiver o texto dentro do input, procuramos
  // a opção/valor "Dentro unidade" visível na página.
  if(localTxt && !/Dentro unidade/i.test(localTxt)){
    const localVisivel=page.getByText('Dentro unidade',{exact:true}).first();
    if(!(await localVisivel.count())){
      throw new Error(
        `Local do evento não está em "Dentro unidade" antes da exportação. Atual: "${localTxt}"`
      );
    }
  }

  await sleep(1800);
  await exportar.click({timeout:10000});
  log(`Exportação solicitada: ${item.nome}`);
}

async function aguardarNovoPedido(page,item,p,quantidadeAntes,segundos=90){
  const limite=Date.now()+segundos*1000;

  while(Date.now()<limite){
    const quantidadeAgora=await contarPedidosValidosAtuais(page,item,p);

    if(quantidadeAgora>quantidadeAntes){
      const info=await infoUltimaLinha(page,item,p);
      log(
        `NOVO pedido correto confirmado: ${item.nome} ` +
        `(${quantidadeAntes} -> ${quantidadeAgora}).`
      );
      return info;
    }

    await sleep(4000);
  }

  return null;
}

async function garantirPedido(page,item,p){
  // REGRA V2.5.5:
  // Se existe um pedido correto (tipo exato + período + localidade)
  // feito há no máximo 30 minutos, NÃO gera novamente.
  const recente=await infoPedidoRecente(page,item,p);

  if(recente){
    log(
      `Reaproveitando ${item.nome}: pedido de ${recente.idadeMin.toFixed(1)} min atrás ` +
      `(${recente.status}). Não será gerado novamente.`
    );
    return recente;
  }

  // Só chega aqui se este indicador realmente estiver faltando
  // ou se o último pedido correto tiver mais de 30 minutos.
  for(let tentativa=1;tentativa<=2;tentativa++){
    // Antes de CADA tentativa, consulta novamente.
    // Se a tentativa anterior apareceu com atraso, não duplica.
    const apareceuEnquantoEsperava=await infoPedidoRecente(page,item,p);
    if(apareceuEnquantoEsperava){
      log(
        `${item.nome} apareceu na consulta antes da nova tentativa. ` +
        `Reaproveitando e evitando pedido duplicado.`
      );
      return apareceuEnquantoEsperava;
    }

    const quantidadeAntes=await contarPedidosValidosAtuais(page,item,p);

    log(
      `Gerando SOMENTE o relatório faltante: ${item.nome}. ` +
      `Pedido(s) correto(s) existentes: ${quantidadeAntes}. Tentativa ${tentativa}/2.`
    );

    await prepararEBuscar(page,item,p);

    const novo=await aguardarNovoPedido(page,item,p,quantidadeAntes,90);
    if(novo) return novo;

    // Consulta final antes de cogitar a segunda exportação.
    const tardio=await infoPedidoRecente(page,item,p);
    if(tardio){
      log(
        `${item.nome} apareceu com atraso em Downloads. ` +
        `Reaproveitando e NÃO gerando novamente.`
      );
      return tardio;
    }

    log(`Nenhum pedido correto e recente de ${item.nome} apareceu em Downloads.`);

    if(tentativa<2){
      log(`Vou repetir SOMENTE ${item.nome}, pois ele continua faltando.`);
      await sleep(3000);
    }
  }

  throw new Error(
    `O Guardian não criou um pedido correto de ${item.nome} após 2 tentativas.`
  );
}


async function preVerificarDownloads(page,p){
  log('');
  log('===== PRÉ-VERIFICAÇÃO DA PÁGINA DOWNLOADS =====');
  log(`Janela de reaproveitamento: ${REUSO_MINUTOS} minutos.`);

  const plano = new Map();

  for(const item of TIPOS){
    const info = await infoUltimaLinha(page,item,p);

    if(
      info.row &&
      info.status !== 'erro' &&
      Number.isFinite(info.idadeMin) &&
      info.idadeMin <= REUSO_MINUTOS
    ){
      plano.set(item.nome,{
        acao:'reaproveitar',
        status:info.status,
        idadeMin:info.idadeMin,
        text:info.text
      });

      if(info.status==='pronto'){
        log(
          `[REUSAR] ${item.nome}: pedido correto de ${info.idadeMin.toFixed(1)} min atrás, já pronto.`
        );
      }else{
        log(
          `[AGUARDAR] ${item.nome}: pedido correto de ${info.idadeMin.toFixed(1)} min atrás ainda processando.`
        );
      }
    }else{
      plano.set(item.nome,{
        acao:'gerar',
        status:info.status || 'ausente',
        idadeMin:info.idadeMin
      });

      if(info.row && Number.isFinite(info.idadeMin)){
        log(
          `[GERAR] ${item.nome}: último pedido correto tem ${info.idadeMin.toFixed(1)} min (> ${REUSO_MINUTOS}).`
        );
      }else{
        log(`[GERAR] ${item.nome}: não há pedido correto e recente.`);
      }
    }
  }

  const faltantes = TIPOS.filter(item => plano.get(item.nome)?.acao === 'gerar');

  if(!faltantes.length){
    log('Pré-verificação concluída: nenhum relatório precisa ser gerado agora.');
  }else{
    log(
      'Pré-verificação concluída. Será(ão) gerado(s) somente: ' +
      faltantes.map(x=>x.nome).join(' | ')
    );
  }

  return plano;
}

async function esperarPronto(page,item,p){
  log(`Aguardando ${item.nome} ficar pronto...`);
  const limite=Date.now()+(CFG.download_wait_ms || 360000);

  while(Date.now()<limite){
    const info=await infoUltimaLinha(page,item,p);

    if(info.row){
      if(info.status==='pronto'){
        log(
          `${item.nome} está pronto. Pedido de ` +
          `${Number.isFinite(info.idadeMin) ? info.idadeMin.toFixed(1) : '?'} min atrás.`
        );
        return info.row;
      }

      if(info.status==='erro'){
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
  console.log(' GUARDIAN 504 - V2.5.9 STATUS CENTRAL CORRIGIDO');
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

    // Antes de tocar em qualquer filtro do Guardian, olha a página Downloads
    // e decide exatamente o que está faltando com base no horário.
    const plano = await preVerificarDownloads(page,p);

    for(const item of TIPOS){
      const decisao = plano.get(item.nome);

      if(decisao?.acao === 'reaproveitar'){
        log('');
        log(
          `===== ${item.nome}: PEDIDO RECENTE ENCONTRADO - NÃO GERAR NOVAMENTE =====`
        );
        continue;
      }

      log('');
      log(`===== GERANDO SOMENTE O FALTANTE: ${item.nome} =====`);
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

    // Quando chamado pela Central 504, NÃO pode ficar esperando ENTER.
    // A Central só registra SUCESSO quando este processo realmente termina.
    if(EXECUTADO_PELA_CENTRAL){
      log('Execução pela Central 504: encerrando automaticamente com SUCESSO.');
      process.exitCode = 0;
    }else{
      console.log('Pressione ENTER para fechar.');
      await esperarEnter();
    }

  }catch(e){
    console.error('');
    console.error('=== FALHA ===');
    console.error(e && e.stack ? e.stack : e);
    console.error('');

    // Antes o catch terminava sem código de erro; isso podia mascarar falhas.
    // Agora a Central recebe exit code 1 e grava ERRO corretamente.
    process.exitCode = 1;

    if(EXECUTADO_PELA_CENTRAL){
      log('Execução pela Central 504: encerrando automaticamente com ERRO.');
    }else{
      console.error('Pressione ENTER para encerrar.');
      await esperarEnter();
    }
  }finally{
    await context.close().catch(()=>{});
  }
}

main();
