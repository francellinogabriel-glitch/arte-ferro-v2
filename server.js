require('dotenv').config();
var express = require('express');
var cors = require('cors');
var path = require('path');
var fs = require('fs');
var multer = require('multer');
var pdfParse = require('pdf-parse');
var uuidv4 = require('uuid').v4;
var Database = require('better-sqlite3');
var GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI;

['data','uploads','propostas','public'].forEach(function(dir) {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

var db = new Database(path.join(__dirname, 'data/sistema.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(
  'CREATE TABLE IF NOT EXISTS orcamentos (' +
  'id TEXT PRIMARY KEY,' +
  'numero INTEGER,' +
  'cliente_nome TEXT,' +
  'cliente_telefone TEXT,' +
  'cliente_email TEXT,' +
  'status TEXT DEFAULT "rascunho",' +
  'pdf_cliente TEXT,' +
  'foto_projeto TEXT,' +
  'itens TEXT,' +
  'custo_material REAL DEFAULT 0,' +
  'custo_pintura REAL DEFAULT 0,' +
  'custo_mao_obra REAL DEFAULT 0,' +
  'custo_total REAL DEFAULT 0,' +
  'valor_venda REAL DEFAULT 0,' +
  'valor_avista REAL DEFAULT 0,' +
  'valor_parcela REAL DEFAULT 0,' +
  'observacoes TEXT,' +
  'criado_em TEXT NOT NULL,' +
  'atualizado_em TEXT' +
  ');' +
  'CREATE TABLE IF NOT EXISTS sequencias (' +
  'chave TEXT PRIMARY KEY,' +
  'valor INTEGER DEFAULT 0' +
  ');' +
  'INSERT OR IGNORE INTO sequencias (chave, valor) VALUES ("orcamento", 0);'
);

function proximoNumeroOrcamento() {
  db.prepare('UPDATE sequencias SET valor = valor + 1 WHERE chave = "orcamento"').run();
  var row = db.prepare('SELECT valor FROM sequencias WHERE chave = "orcamento"').get();
  return row.valor;
}

var mult = parseFloat(process.env.MULTIPLICADOR_VENDA) || 2.5;
var pintBasica = parseFloat(process.env.PRECO_PINTURA_BASICA) || 100;
var pintEspecial = parseFloat(process.env.PRECO_PINTURA_ESPECIAL) || 150;
var descAvista = parseFloat(process.env.DESCONTO_AVISTA) || 0.10;
var maxParcelas = parseInt(process.env.MAX_PARCELAS, 10) || 10;

function areaM2(larg, alt) {
  return (larg / 100) * (alt / 100);
}

function custoPintura(larg, alt, tipo) {
  if (!tipo || tipo === 'sem_pintura') return 0;
  var base = tipo === 'especial' ? pintEspecial : pintBasica;
  return areaM2(larg, alt) * base;
}

function calcularOrcamento(itens) {
  var lista = itens || [];
  var totalMat = 0;
  var totalPint = 0;
  var totalMO = 0;
  var itensCalc = lista.map(function(item) {
    var qtd = item.quantidade || 1;
    var larg = item.largura_cm || 0;
    var alt = item.altura_cm || 0;
    var matU = item.custo_material_unitario || 0;
    var pintU = custoPintura(larg, alt, item.tipo_pintura);
    var moU = item.mao_obra_unitaria || 0;
    var custoU = matU + pintU + moU;
    var custoT = custoU * qtd;
    var vendaT = custoT * mult;
    totalMat += matU * qtd;
    totalPint += pintU * qtd;
    totalMO += moU * qtd;
    return {
      descricao: item.descricao || '',
      largura_cm: larg,
      altura_cm: alt,
      quantidade: qtd,
      material: item.material || '',
      tipo_pintura: item.tipo_pintura || 'basica',
      custo_material_unitario: matU,
      custo_pintura_unitario: parseFloat(pintU.toFixed(2)),
      mao_obra_unitaria: moU,
      custo_unitario: parseFloat(custoU.toFixed(2)),
      custo_total_item: parseFloat(custoT.toFixed(2)),
      valor_venda_item: parseFloat(vendaT.toFixed(2)),
      observacoes: item.observacoes || null
    };
  });
  var custoTotal = totalMat + totalPint + totalMO;
  var valorVenda = custoTotal * mult;
  return {
    itens: itensCalc,
    custo_material: parseFloat(totalMat.toFixed(2)),
    custo_pintura: parseFloat(totalPint.toFixed(2)),
    custo_mao_obra: parseFloat(totalMO.toFixed(2)),
    custo_total: parseFloat(custoTotal.toFixed(2)),
    valor_venda: parseFloat(valorVenda.toFixed(2)),
    valor_avista: parseFloat((valorVenda * (1 - descAvista)).toFixed(2)),
    valor_parcela: parseFloat((valorVenda / maxParcelas).toFixed(2)),
    max_parcelas: maxParcelas
  };
}

var genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

function extrairDadosPDF(texto) {
  if (!process.env.GEMINI_API_KEY) {
    return Promise.resolve({ cliente: { nome: null, telefone: null, email: null }, itens: [], observacoes_gerais: null, confianca: 'baixa' });
  }
  var model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
  var prompt = 'Voce e especialista em orcamentos de serralheria artistica. Analise o texto abaixo e retorne APENAS um JSON valido sem explicacoes. TEXTO: ' + texto + ' FORMATO EXATO: {"cliente":{"nome":"","telefone":"","email":""},"itens":[{"descricao":"","largura_cm":0,"altura_cm":0,"quantidade":1,"material":"","custo_material_unitario":0,"tipo_pintura":"basica","mao_obra_unitaria":0,"observacoes":null}],"observacoes_gerais":"","confianca":"baixa"}';
  return model.generateContent(prompt).then(function(result) {
    var txt = result.response.text().trim().replace(/json\n?/g, '').replace(/\n?/g, '').trim();
    return JSON.parse(txt);
  });
}

function extrairDadosImagem(imagemPath, mimeType) {
  if (!process.env.GEMINI_API_KEY) {
    return Promise.resolve({ cliente: { nome: null, telefone: null, email: null }, itens: [], observacoes_gerais: null, confianca: 'baixa' });
  }
  var model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
  var imagemBase64 = fs.readFileSync(imagemPath).toString('base64');
  var prompt = 'Voce e especialista em serralheria artistica. Analise esta imagem de um projeto e retorne APENAS um JSON valido. FORMATO EXATO: {"cliente":{"nome":null,"telefone":null,"email":null},"itens":[{"descricao":"descreva o que voce ve","largura_cm":0,"altura_cm":0,"quantidade":1,"material":"ferro ou aco ou aluminio","custo_material_unitario":0,"tipo_pintura":"basica","mao_obra_unitaria":0,"observacoes":"detalhes visuais"}],"observacoes_gerais":"descricao geral","confianca":"media"}';
  return model.generateContent([
    { inlineData: { mimeType: mimeType || 'image/jpeg', data: imagemBase64 } },
    { text: prompt }
  ]).then(function(result) {
    var txt = result.response.text().trim().replace(/json\n?/g, '').replace(/\n?/g, '').trim();
    return JSON.parse(txt);
  });
}

var app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

var storage = multer.diskStorage({
  destination: function(req, file, cb) { cb(null, path.join(__dirname, 'uploads')); },
  filename: function(req, file, cb) { cb(null, uuidv4() + path.extname(file.originalname)); }
});

var upload = multer({ storage: storage, limits: { fileSize: 50 * 1024 * 1024 } }).fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'imagens', maxCount: 10 }
]);

function agoraISO() { return new Date().toISOString(); }

function dadosVazios() {
  return { cliente: { nome: null, telefone: null, email: null }, itens: [], observacoes_gerais: null, confianca: 'baixa' };
}

function salvarOrcamento(dados, pdfFile, caminhosImagens, res) {
  var calculo = calcularOrcamento(dados.itens || []);
  var id = uuidv4();
  var numero = proximoNumeroOrcamento();
  db.prepare(
    'INSERT INTO orcamentos (id, numero, cliente_nome, cliente_telefone, cliente_email, status, pdf_cliente, foto_projeto, itens, custo_material, custo_pintura, custo_mao_obra, custo_total, valor_venda, valor_avista, valor_parcela, observacoes, criado_em) VALUES (@id, @numero, @cliente_nome, @cliente_telefone, @cliente_email, @status, @pdf_cliente, @foto_projeto, @itens, @custo_material, @custo_pintura, @custo_mao_obra, @custo_total, @valor_venda, @valor_avista, @valor_parcela, @observacoes, @criado_em)'
  ).run({
    id: id,
    numero: numero,
    cliente_nome: dados.cliente ? dados.cliente.nome || null : null,
    cliente_telefone: dados.cliente ? dados.cliente.telefone || null : null,
    cliente_email: dados.cliente ? dados.cliente.email || null : null,
    status: 'rascunho',
    pdf_cliente: pdfFile ? pdfFile.path : null,
    foto_projeto: JSON.stringify(caminhosImagens),
    itens: JSON.stringify(calculo.itens),
    custo_material: calculo.custo_material,
    custo_pintura: calculo.custo_pintura,
    custo_mao_obra: calculo.custo_mao_obra,
    custo_total: calculo.custo_total,
    valor_venda: calculo.valor_venda,
    valor_avista: calculo.valor_avista,
    valor_parcela: calculo.valor_parcela,
    observacoes: dados.observacoes_gerais || null,
    criado_em: agoraISO()
  });
  res.status(201).json({ id: id, numero: numero, calculo: calculo, dados_ia: dados, imagens: caminhosImagens });
}

app.get('/api/orcamentos', function(req, res) {
  var lista = db.prepare('SELECT * FROM orcamentos ORDER BY criado_em DESC').all().map(function(o) {
    o.itens = JSON.parse(o.itens || '[]');
    return o;
  });
  res.json(lista);
});

app.post('/api/orcamentos/upload', upload, function(req, res) {
  var arquivos = req.files || {};
  var pdfFile = arquivos.pdf ? arquivos.pdf[0] : null;
  var imagensFiles = arquivos.imagens || [];
  var caminhosImagens = imagensFiles.map(function(f) { return f.path; });

  if (pdfFile) {
    var bufferPdf = fs.readFileSync(pdfFile.path);
    pdfParse(bufferPdf).then(function(parsed) {
      return extrairDadosPDF(parsed.text);
    }).then(function(dados) {
      salvarOrcamento(dados, pdfFile, caminhosImagens, res);
    }).catch(function(err) {
      console.error('Erro PDF:', err);
      salvarOrcamento(dadosVazios(), pdfFile, caminhosImagens, res);
    });
  } else if (imagensFiles.length > 0) {
    var primeiraImg = imagensFiles[0];
    extrairDadosImagem(primeiraImg.path, primeiraImg.mimetype).then(function(dados) {
      salvarOrcamento(dados, null, caminhosImagens, res);
    }).catch(function(err) {
      console.error('Erro imagem:', err);
      salvarOrcamento(dadosVazios(), null, caminhosImagens, res);
    });
  } else {
    salvarOrcamento(dadosVazios(), null, [], res);
  }
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Arte e Ferro rodando na porta ' + PORT);
});
