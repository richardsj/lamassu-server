var db = require('./db')

exports.up = function (next) {
  var sql = [
    'create sequence hd_indices_seq minvalue 0 maxvalue 2147483647',
    'alter table cash_out_txs add column hd_index integer not null',
    'alter sequence hd_indices_seq owned by cash_out_txs.hd_index',
    'alter table cash_out_txs add column sweep_time timestamptz',
    'alter table cash_out_txs add column sweep_hash text',
    'create unique index on cash_out_txs (hd_index DESC)',
    'drop table cash_out_hds'
  ]
  db.multi(sql, next)
}

exports.down = function (next) {
  next()
}
