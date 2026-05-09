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
  '  id TEXT PRIMARY KEY,' +
  '  numero INTEGER,' +
  '  cliente_nome TEXT,' +
  '  cliente_telefone TEXT,' +
  '  cliente_email TEXT,' +
  '  status TEXT DEFAULT "rascunho",' +
  '  pdf_cliente TEXT,' +
  '  foto_projeto TEXT,' +
  '  itens TEXT,' +
  '  custo_material REAL DEFAULT 0,' +
  '  custo_pintura REAL DEFAULT 0,' +
  '  custo_mao_obra REAL DEFAULT 0,' +
  '  custo_total REAL DEFAULT 0,' +
  '  valor_venda REAL DEFAULT 0,' +
  '  valor_avista REAL DEFAULT 0,' +
  '  valor_parcela REAL DEFAULT 0,' +
  '  observacoes TEXT,' +
  '  criado_em TEXT NOT NULL,' +
  '  atualizado_em TEXT' +
  ');' +
  'CREATE TABLE IF NOT EXISTS sequencias (' +
  '  chave TEXT PRIMARY KEY,' +
  '  valor INTEGER DEFAULT 0' +
  ');' +
  'INSERT OR IGNORE INTO sequencias (chave, valor) VALUES ("orcamento", 0);'
);

function proximoNumeroOrcamento() {
  db.prepare(
    'UPDATE sequencias SET valor = valor + 1 WHERE chave = "orcamento"'
  ).run();
  var row = db.prepare(
    'SELECT valor FROM sequencias WHERE chave = "orcamento"'
  ).get();
  return row.valor;
}

var CFG = {
  mult: parseFloat(process.env.MULTIPLICADOR_VENDA) || 2.5,
  pintBasica: parseFloat(process.env.PRECO_PINTURA_BASICA) || 100,
  pintEspecial: parseFloat(process.env.PRECO_PINTURA_ESPECIAL) || 150,
  desc
