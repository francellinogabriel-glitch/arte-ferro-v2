require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { v4: uuid } = require('uuid');
const Database = require('better-sqlite3');
const { GoogleGenerativeAI } = require('@google/generative-ai');

['data', 'uploads', 'propostas', 'public'].forEach((dir) => {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

const db = new Database(path.join(__dirname, 'data/sistema.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS clientes (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    telefone TEXT,
    email TEXT,
    cpf_cnpj TEXT,
    endereco TEXT,
    cidade TEXT,
    tipo TEXT DEFAULT 'pessoa_fisica',
    observacoes TEXT,
    criado_em TEXT NOT NULL,
    ativo INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orcamentos (
    id TEXT PRIMARY KEY,
    numero INTEGER,
    cliente_nome TEXT,
    cliente_telefone TEXT,
    cliente_email TEXT,
    status TEXT DEFAULT 'rascunho',
    pdf_cliente TEXT,
    foto_projeto TEXT,
    itens TEXT,
    custo_material REAL DEFAULT 0,
    custo_pintura REAL DEFAULT 0,
    custo_mao_obra REAL DEFAULT 0,
    custo_total REAL DEFAULT 0,
    valor_venda REAL DEFAULT 0,
    valor_avista REAL DEFAULT 0,
    valor_parcela REAL DEFAULT 0,
    observacoes TEXT,
    pdf_proposta TEXT,
    criado_em TEXT NOT NULL,
    atualizado_em TEXT
  );

  CREATE TABLE IF NOT EXISTS sequencias (
    chave TEXT PRIMARY KEY,
    valor INTEGER DEFAULT 0
  );
  INSERT OR IGNORE INTO sequencias (chave, valor) VALUES ('orcamento', 0);
`);

function proximoNumeroOrcamento() {
  db.prepare(UPDATE sequencias SET valor = valor + 1 WHERE chave = 'orcamento').run();
  const row = db.prepare(SELECT valor FROM sequencias WHERE chave = 'orcamento').get();
  return row.valor;
}

const CFG = {
  mult: parseFloat(process.env.MULTIPLICADOR_VENDA) || 2.5,
  pintBasica: parseFloat(process.env.PRECO_PINTURA_BASICA) || 100,
  pintEspecial: parseFloat(process.env.PRECO_PINTURA_ESPECIAL) || 150,
  descAvista: parseFloat(process.env.DESCONTO_AVISTA) || 0.10,
  parcelas: parseInt(process.env.MAX_PARCELAS, 10) || 10
};

function areaM2(largura_cm, altura_cm) {
  return (largura_cm / 100) * (altura_cm / 100);
}

function custoPintura(largura_cm, altura_cm, tipo) {
  if (!tipo || tipo === 'sem_pintura') return 0;
  const base = tipo === 'especial' ? CFG.pintEspecial : CFG.pintBasica;
  return areaM2(largura_cm, altura_cm) * base;
}

function calcularOrcamento(itens) {
  var lista = itens || [];
  var totalMat = 0;
  var totalPint = 0;
  var totalMO = 0;

  var itensCalculados = lista.map(function(item) {
    var qtd = item.quantidade || 1;
    var largura = item.largura_cm || 0;
    var altura = item.altura_cm || 0;
    var matUnit = item.custo_material_unitario || 0;
    var pintUnit = custoPintura(largura, altura, item.tipo_pintura);
    var moUnit = item.mao_obra_unitaria || 0;

    var matItem = matUnit * qtd;
    var pintItem = pintUnit * qtd;
    var moItem = moUnit * qtd;
    var custoUnit = matUnit + pintUnit + moUnit;
    var custoTotalItem = custoUnit * qtd;
    var vendaItem = custoTotalItem * CFG.mult;

    totalMat += matItem;
    totalPint += pintItem;
    totalMO += moItem;

    return Object.assign({}, item, {
      area_m2: parseFloat(areaM2(largura, altura).toFixed(4)),
      custo_pintura_unitario: parseFloat(pintUnit.toFixed(2)),
      custo_material_item: parseFloat(matItem.toFixed(2)),
      custo_pintura_item: parseFloat(pintItem.toFixed(2)),
      custo_mao_obra_item: parseFloat(moItem.toFixed(2)),
      custo_unitario: parseFloat(custoUnit.toFixed(2)),
      custo_total_item: parseFloat(custoTotalItem.toFixed(2)),
      valor_venda_item: parseFloat(vendaItem.toFixed(2))
    });
  });

  var custoTotal = totalMat + totalPint + totalMO;
  var valorVenda = custoTotal * CFG.mult;

  return {
    itens: itensCalculados,
    custo_material: parseFloat(totalMat.toFixed(2)),
    custo_pintura: parseFloat(totalPint.toFixed(2)),
    custo_mao_obra: parseFloat(totalMO.toFixed(2)),
    custo_total: parseFloat(custoTotal.toFixed(2)),
    valor_venda: parseFloat(valorVenda.toFixed(2)),
    valor_avista: parseFloat((valorVenda * (1 - CFG.descAvista)).toFixed(2)),
    valor_parcela: parseFloat((valorVenda / CFG.parcelas).toFixed(2)),
    max_parcelas: CFG.parcelas,
    multiplicador: CFG.mult
  };
}

var genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function extrairDadosPDF(texto) {
  if (!process.env.GEMINI_API_KEY) {
    return { cliente: { nome: null, telefone: null, email: null }, itens: [], observacoes_gerais: null, confianca: 'baixa' };
  }
  var model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
  var prompt = 'Voce e especialista em orcamentos de serralheria artistica.\nAnalise o texto abaixo de um PDF de orcamento e retorne APENAS um JSON valido.\n\nTEXTO DO PDF:\n' + texto + '\n\nFORMATO EXATO:\n{\n  "cliente": { "nome": "", "telefone": "", "email": "" },\n  "itens": [{ "descricao": "", "largura_cm": 0, "altura_cm": 0, "quantidade": 1, "material": "", "custo_material_unitario": 0, "tipo_pintura": "basica", "mao_obra_unitaria": 0, "observacoes": null }],\n  "observacoes_gerais": "",\n  "confianca": "baixa|media|alta"\n}';
  var result = await model.generateContent(prompt);
  var responseText = result.response.text().trim().replace(/json\n?/g, '').replace(/\n?/g, '').trim();
  return JSON.parse(responseText);
}

var app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

var storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, path.join(__dirname, 'uploads'));
  },
  filename: function(req, file, cb) {
    cb(null, uuid() + path.extname(file.originalname));
  }
});

var upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
}).fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'imagens', maxCount: 10 }
]);

var agoraISO = function() { return new Date().toISOString(); };

app.get('/api/orcamentos', function(req, res) {
  var orcamentos = db.prepare('SELECT * FROM orcamentos ORDER BY criado_em DESC').all().map(function(o) {
    return Object.assign({}, o, { itens: JSON.parse(o.itens || '[]') });
  });
  res.json(orcamentos);
});

app.post('/api/orcamentos/upload', upload, async function(req, res) {
  try {
    var arquivos = req.files || {};
    var pdfFile = arquivos.pdf ? arquivos.pdf[0] : null;
    var imagensFiles = arquivos.imagens || [];
    var caminhosImagens = imagensFiles.map(function(f) { return f.path; });

    var dadosIA = { cliente: { nome: null, telefone: null, email: null }, itens: [], observacoes_gerais: null, confianca: 'baixa' };

    if (pdfFile) {
      try {
        var buffer = fs.readFileSync(pdfFile.path);
        var parsed = await pdfParse(buffer);
        dadosIA = await extrairDadosPDF(parsed.text);
      } catch (erroIA) {
        console.error('Erro ao processar PDF ou IA:', erroIA);
      }
    }

    var calculo = calcularOrcamento(dadosIA.itens || []);
    var id = uuid();
    var numero = proximoNumeroOrcamento();

    db.prepare('INSERT INTO orcamentos (id, numero, cliente_nome, cliente_telefone, cliente_email, status, pdf_cliente, foto_projeto, itens, custo_material, custo_pintura, custo_mao_obra, custo_total, valor_venda, valor_avista, valor_parcela, observacoes, criado_em) VALUES (@id, @numero, @cliente_nome, @cliente_telefone, @cliente_email, @status, @pdf_cliente, @foto_projeto, @itens, @custo_material, @custo_pintura, @custo_mao_obra, @custo_total, @valor_venda, @valor_avista, @valor_parcela, @observacoes, @criado_em)').run({
      id: id,
      numero: numero,
      cliente_nome: dadosIA.cliente ? dadosIA.cliente.nome || null : null,
      cliente_telefone: dadosIA.cliente ? dadosIA.cliente.telefone || null : null,
      cliente_email: dadosIA.cliente ? dadosIA.cliente.email || null : null,
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
      observacoes: dadosIA.observacoes_gerais || null,
      criado_em: agoraISO()
    });

    res.status(201).json({ id: id, numero: numero, calculo: calculo, dados_ia: dadosIA, imagens: caminhosImagens });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: err.message });
  }
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

var PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
  console.log('Arte e Ferro v2 rodando na porta ' + PORT);
});
