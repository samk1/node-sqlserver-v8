/**
 * Created by Stephen on 9/28/2015.
 */

/*
 supports bulk table operations, delete, modify and insert. Also capture table definition such that
 template sql statements can be used to insert single entries.  For insert, the first element
 represents the definition to use for all elements i.e. to bind to the statement in the native driver.
 the manager supports batches where preparation in driver can be preserved i.e. prepare batch
 of 100 against object will then allow 100 rows at a time to be sent to server before the entire
 transaction is ultimately committed.  Also provide some performance metrics to allow fine tuning
 of batch size.

 this manager will ultimately become the underlying mechanism for simple "entity framework" like
 transactions i.e. working with a concrete java script type that requires efficient binding to
 the database, thus it must be robust and simple to enhance.
 */

var dm = require('./driverMgr');
var fs = require('fs');

var folder = __dirname ;

exports.tableMgr = function (c) {
    var cache = {};
    var bulkTableManagers = {};
    var conn = c;
    var batch = 0;

    function readFile(f, done) {
        fs.readFile(f, 'utf8', function (err, data) {
            if (err) {
                done(err);
            } else
                done(data);
        });
    }

    function describeTable(tableName, callback) {

        var sql;
        readFile(folder + '/describe.sql', done);

        function done(data) {
            sql = data.replace("<table_name>", tableName);
            conn.query(sql, function (err, results) {
                callback(err, results);
            });
        }
    }

    /*
     based on an instance bind properties of that instance to a given table.
     Will have to allow for not all properties binding i.e. may be partial persistence - and allow for
     mappings i.e. object.myName = table.<name> or table.my_name etc.
     */

    function describe(name, cb) {
        var meta = cache[name];
        if (meta == null) {
            describeTable(name, function (err, cols) {
                var signature = build(name, cols);
                var colByName = {};
                for (var c = 0; c < cols.length; ++c) {
                    colByName[cols[c].name] = cols[c];
                }
                var meta = {
                    insert_signature: signature,
                    columns: cols,
                    by_name: colByName
                };
                cache[name] = meta;
                cb(meta);
            });
        } else cb(meta);
    }

    function build(name, cols) {
        var sql = "insert into " + name + " ( ";
        var count = 0;
        cols.forEach(function (col) {
            if (col.is_identity === 0
                && col.is_computed === false) {
                ++count;
                sql += col.name;
                sql += ", ";
            }
        });

        if (count > 0) {
            sql = sql.substr(0, sql.length - 2);
        }

        sql += " ) ";

        if (count > 0) {
            sql += "values (";
            for (var i = 0; i < count; ++i) {
                sql += "?";
                if (i < count - 1) sql += ", ";
            }
            sql += ")";
        }

        return sql;
    }

    function bulkTableOpMgr(n, m) {

        var name = n;
        var meta = m;

        // create an object of arrays where each array represents all values
        // for the batch.

        function prepare(vec, o, arrays) {
            var keys = [];
            if (vec.length === 0) return keys;
            var first = vec[0];
            meta.columns.forEach(function(col) {
                var property = col.name;
                if (first.hasOwnProperty(property)
                    && meta.by_name.hasOwnProperty(property)
                    && meta.by_name[property].is_computed === false) {
                    keys.push(property);
                    var arr = o[property];
                    if (arr == null) {
                        arr = [];
                        o[property] = arr;
                        arrays.push(arr);
                    }
                }
            });
            return keys;
        }

        function arrayPerColumn(vec) {

            var o = {};
            var arrays = [];
            var keys = prepare(vec, o, arrays);

            vec.forEach(function (instance) {
                keys.forEach(function (property) {
                    var arr = o[property];
                    arr.push(instance[property]);
                });
            });

            return arrays;
        }

        // if batch size is set, split the input into that batch size.

        function rowBatches(rows) {
            var batches = [];

            if (batch === 0) {
                batches.push(rows);
            } else {
                var b = [];
                for (var i = 0; i < rows.length; ++i) {
                    b.push(rows[i]);
                    if (b.length === batch) {
                        batches.push(b);
                        b = [];
                    }
                }
            }

            return batches;
        }

        // driver will have to recognise this is an array of arrays where each array
        // represents all values for that particular column.

        function insertRows(rows, callback) {

            var batches = rowBatches(rows);
            var sql = meta.insert_signature;
            var b = 0;

            iterate();

            function iterate() {
                var batch = batches[b];
                var cols = arrayPerColumn(batch);
                conn.query(sql, cols, done);
            }

            function done(err, results) {
                ++b;
                if (err == null && b < batches.length) {
                    iterate();
                } else callback(err, results);
            }
        }

        function updateRows(vec, done) {
        }

        function deleteRows(vec, done) {
        }

        function getName() {
            return name;
        }

        // public api

        this.insertRows = insertRows;
        this.updateRows = updateRows;
        this.deleteRows = deleteRows;
        this.getName = getName;

        return this;
    }

    function bind(table, cb) {
        describe(table, function (meta) {
            var mgr = bulkTableOpMgr(table, meta);
            bulkTableManagers[table] = mgr;
            cb(mgr);
        });
    }

    function setBatchSize(bs) {
        batch = bs;
    }

    this.describe = describe;
    this.bind = bind;
    this.setBatchSize = setBatchSize;

    return this;
};