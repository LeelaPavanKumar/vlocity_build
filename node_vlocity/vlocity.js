var jsforce = require('jsforce');
var datapacks = require('./datapacks');
var datapacksjob = require('./datapacksjob');
var datapacksexpand = require('./datapacksexpand');
var datapacksbuilder = require('./datapacksbuilder');
var datapacksutils = require('./datapacksutils');
var datapacksexportbuildfile = require('./datapacksexportbuildfile');
var vlocityutils = require('./vlocityutils.js');

var nopt = require('nopt');

var Vlocity = module.exports = function(options) {
    options = options || {};

    this.username = options.username;
    this.password = options.password;

    this.namespace = options.vlocityNamespace ? options.vlocityNamespace : '';
    VlocityUtils.namespace = this.namespace;

    this.namespacePrefix = this.namespace ? this.namespace + '__' : '';
    this.verbose = !!options.verbose;
    this.sessionId = options.sessionId;
    this.instanceUrl = options.instanceUrl;
    this.accessToken = options.accessToken;

    this.tempFolder = './vlocity-temp';

    if (this.verbose) {
        VlocityUtils.log('Verbose mode enabled');
    }

    this.jsForceConnection = new jsforce.Connection({
        loginUrl: options.loginUrl ? options.loginUrl : 'https://login.salesforce.com',
        sessionId: this.sessionId,
        instanceUrl: this.instanceUrl,
        accessToken: this.accessToken
    });

    this.isLoggedIn = false;

    this.datapacksutils = new datapacksutils(this);
    this.datapacks = new datapacks(this);
    this.datapacksjob = new datapacksjob(this);
    this.datapacksexpand = new datapacksexpand(this);
    this.datapacksbuilder = new datapacksbuilder(this);
    this.datapacksexportbuildfile = new datapacksexportbuildfile(this);
};

Vlocity.prototype.checkLogin = function(callback) {
    var self = this;

    if (self.isLoggedIn || self.sessionId || self.accessToken) {    
        callback();
    } else {
        self.jsForceConnection.login(self.username, self.password, function(err, res) {

            if (err) { 
                VlocityUtils.error(err); 
                return false; 
            }
            
            self.isLoggedIn = true;
            callback();
        });
    }
};