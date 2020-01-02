var jsforce = require('jsforce');
var yaml = require('js-yaml');
var fs = require('fs-extra');
var path = require('path');
var stringify = require('json-stable-stringify');
var childProcess = require('child_process');
var sfdx = require('salesforce-alm');
const simpleGit = require('simple-git');
const gitP = require('simple-git/promise');

var unidecode = require('unidecode'); 

const VLOCITY_NAMESPACE = '%vlocity_namespace%';

var UtilityService = module.exports = function(vlocity) {
    this.vlocity = vlocity || {};
};

UtilityService.prototype.replaceAll = function(str, find, replace) {
    return str.replace(new RegExp(find, 'g'), replace);
};

UtilityService.prototype.setNamespaceToOrg = function(value) {
    if(this.vlocity.namespace){
        if(JSON.stringify(value).includes(VLOCITY_NAMESPACE+'__')){
            return JSON.parse(JSON.stringify(value).replace(new RegExp(VLOCITY_NAMESPACE, 'g'), this.vlocity.namespace));
        } else{
            return JSON.parse(JSON.stringify(this.vlocity.namespace + '__' + value));
        }
    } else{
        return JSON.parse(JSON.stringify(value).replace(new RegExp(VLOCITY_NAMESPACE+'__', 'g'), ''));
    }
};

UtilityService.prototype.setNamespaceToDefault = function(value) {

    if (!value) return value;

    if(this.vlocity.namespace) {
        return JSON.parse(JSON.stringify(value).replace(new RegExp(this.vlocity.namespace, 'g'), VLOCITY_NAMESPACE));
    }
    else {
        return JSON.parse(JSON.stringify(value));
    }
};

UtilityService.prototype.buildHashMap = function(fields, records) {
    var fieldsValuesMap = {};

    for (var i = 0; i < records.length; i++) {
        for (var key in fields) {
            if (records[i].hasOwnProperty(key)) {
                var uniqueKey = key + records[i][key];
                uniqueKey = uniqueKey.toLowerCase();
                
                if (!fieldsValuesMap[uniqueKey]) {
                    fieldsValuesMap[uniqueKey] = [];
                    fieldsValuesMap[uniqueKey].field = key;
                    fieldsValuesMap[uniqueKey].value = records[i][key];
                }
                
                fieldsValuesMap[uniqueKey].push(records[i]);
            }
        }
    }

    return fieldsValuesMap;
};

UtilityService.prototype.getDataPackData = function(dataPack) {
    if (dataPack) {
        for (var key in dataPack.VlocityDataPackData) {
            if (dataPack.VlocityDataPackData[key] 
                && dataPack.VlocityDataPackData[key] instanceof Array) {
                    return dataPack.VlocityDataPackData[key][0];
                }
        }
    }

    return {};
};

UtilityService.prototype.isEmptyObject = function(obj) {
    for (var name in obj) {
        return false;
    }
    return true;
};

UtilityService.prototype.mergeMaps = function(firstMap, secondMap) {
    for (var key in secondMap) {
        firstMap[key] = secondMap[key];
    }

    return firstMap;
};

UtilityService.prototype.createCustomMetadataRecord = async function(metadata) {
    
    if (metadata && !this.vlocity.utilityservice.isEmptyObject(metadata)) {
        metadata = this.setNamespaceToOrg(metadata);
        var results;
         
        try {

            results = await this.vlocity.jsForceConnection.metadata.create('CustomMetadata', metadata);

            if (results) {
                VlocityUtils.verbose('Create Custom Metadata Record', results);

                if (!Array.isArray(results)) {
                    results = [ results ];
                }
                
                for (var result of results) {
                    if (results && !result.success) {
                        VlocityUtils.error('Create Failed', result.errors);
                    }
                }
    
                return results;
            }
        } catch (e) {
            VlocityUtils.error('Create Failed', results, e.message);
        }
    }
};

UtilityService.prototype.getVlocityDataPackConfigurations = async function() {
    var resultMap = {};

    try {
        var queryResult = await this.vlocity.queryservice.query('SELECT Id,DeveloperName,NamespacePrefix FROM %vlocity_namespace%__VlocityDataPackConfiguration__mdt');

        if (queryResult && queryResult.records) {
            var records = this.setNamespaceToDefault(queryResult.records);

            for (var i = 0; i < records.length; i++) {
                var fieldName = records[i]['DeveloperName'];

                if (resultMap[fieldName]) {
                    if (records[i]['NamespacePrefix'] !== null) {
                        continue;
                    }
                }

                resultMap[fieldName] = records[i];
            }
        }
    } catch (e) {
        VlocityUtils.error('Query Failed', e.message);
    }

    return resultMap;
};

UtilityService.prototype.getDRMatchingKeys = async function() {
    var resultMap = {};

    var queryResult = await this.vlocity.queryservice.query('SELECT Id,Label,NamespacePrefix,%vlocity_namespace%__ObjectAPIName__c,%vlocity_namespace%__MatchingKeyFields__c FROM %vlocity_namespace%__DRMatchingKey__mdt');

    if (queryResult && queryResult.records) {
        var records = this.setNamespaceToDefault(queryResult.records);

        for (var i = 0; i < records.length; i++) {
            if(this.vlocity.namespace){
                var fieldName = records[i]['%vlocity_namespace%__ObjectAPIName__c'];
            } else{
                var fieldName = records[i]['ObjectAPIName__c'];
            }
            if (resultMap[fieldName]) {
                if (records[i]['NamespacePrefix'] !== null) {
                    continue;
                }
            }

            resultMap[fieldName] = records[i];
        }
    }

    return resultMap;
};

UtilityService.prototype.getDRMatchingKeyFields = async function() {
    var result = await this.getDRMatchingKeys();

    for (var objectName in result) {
        if(this.vlocity.namespace){
            result[objectName] = result[objectName]['%vlocity_namespace%__MatchingKeyFields__c'].split(',');
        } else{
            result[objectName] = result[objectName]['MatchingKeyFields__c'].split(',');
        }
    }
    return result;
};

UtilityService.prototype.runInputMap = async function(inputList, status, allLimitPromiseThreads) {
    try {
        while (inputList.length > 0 && !status.cancel) {
            var inputMap = inputList.shift();
            await inputMap.context[inputMap.func](inputMap.argument);
        }
    } catch (e) {
        status.cancel = true;
        status.errors.push(e);
    }
}

UtilityService.prototype.parallelLimit = async function(inputList, limit = 50) {

    var allLimitPromiseThreads = [];
    var status = { cancel: false, errors: [] };

    for (var i = 0; i < limit; i++) {
        allLimitPromiseThreads.push(this.runInputMap(inputList, status, allLimitPromiseThreads));
    }

    do {
        try {
            await Promise.all(allLimitPromiseThreads);
        } catch (e) {
            status.errors.push(e);
        }
    } while (inputList.length > 0 && !status.cancel) 

    if (status.errors.length > 0) {
        throw status.errors;
    }
};

UtilityService.prototype.forceFinish = async function(inFlight, errors) {
    try {
        await Promise.all(inFlight);
    } catch (e) {
        errors.push(e);
        await this.forceFinish(inFlight, errors);
    }
}

UtilityService.prototype.createSObject = async function(sObjectType, sObject) {
    return await this.vlocity.jsForceConnection.sobject(sObjectType).create(sObject);
};

UtilityService.prototype.updateSObject = async function(sObjectType, sObject) {
    if (sObject && !this.isEmptyObject(sObject)) {
        sObject = this.vlocity.utilityservice.setNamespaceToOrg(sObject);
        sObjectType = this.vlocity.utilityservice.setNamespaceToOrg(sObjectType);

        try {
            var results = await this.vlocity.jsForceConnection.sobject(sObjectType).update(sObject);
                
            if (!(results instanceof Array)) {
                results = [results];
            }
        
            for (var res of results) {
                if (!res.success) {
                    VlocityUtils.error('Update Failed', res.errors);
                }
            }
        
            return this.vlocity.utilityservice.setNamespaceToDefault(results);

        } catch (e) {
            VlocityUtils.error('Update Failed', e.message); 
        }
    }
};

UtilityService.prototype.loginFailedMessage = function(error) {
    return 'Login Failed - Username: ' + (this.vlocity.username ? (this.vlocity.username + ' ') : 'None Provided') + ' Error ' + error;
}

UtilityService.prototype.login = async function(retryCount) {
    
    try {
        var result = await this.vlocity.jsForceConnection.login(this.vlocity.username, this.vlocity.password);

        this.vlocity.organizationId = result.organizationId;
    } catch (err) {
        if (!retryCount || retryCount < 5) {
            VlocityUtils.error('Login Failed', 'Retrying', this.loginFailedMessage(err));
            await this.login(retryCount ? ++retryCount : 1);
        } else {
            throw this.loginFailedMessage(err);
        }
    }
}

UtilityService.prototype.sfdxLogin = async function() {
    VlocityUtils.report('Using SFDX', this.vlocity.sfdxUsername);

    try {
        var stored = JSON.parse(fs.readFileSync(path.join(this.vlocity.tempFolder, 'sfdx', this.vlocity.sfdxUsername + '.json')));

        this.vlocity.jsForceConnection = new jsforce.Connection(stored);

        var identity = await this.vlocity.jsForceConnection.identity();
        
        if (identity.username == stored.username) {
            VlocityUtils.report(`SFDX Authenticated - ${this.vlocity.sfdxUsername} - ${identity.username}`);

            this.vlocity.organizationId = identity.organization_id;
            return stored;
        }
    } catch (e) {
        VlocityUtils.verbose('Session Not Found');
    }

    VlocityUtils.report('Refreshing SFDX Session', this.vlocity.sfdxUsername);

    try {
        var orgInfo = await this.sfdx('org:display', { targetusername: this.vlocity.sfdxUsername });

        this.vlocity.organizationId = orgInfo.id;
        this.vlocity.jsForceConnection = new jsforce.Connection(orgInfo);

        try {
            fs.outputFileSync(path.join(this.vlocity.tempFolder, 'sfdx', this.vlocity.sfdxUsername + '.json'), JSON.stringify(orgInfo, null, 4));
        } catch (ex) {
            VlocityUtils.error('Error Saving SFDX Credentials', ex);
        }
    
        return orgInfo;

    } catch (e) {
        VlocityUtils.error('SFDX Login Error', e)
        throw this.loginFailedMessage('Salesforce DX Org Info Invalid - Please Login Again', e.message);
    }
}

UtilityService.prototype.checkLogin = async function() {
    
    VlocityUtils.verbose('Check Login');
    try {
        if (this.vlocity.sessionId || this.vlocity.accessToken) {
            await this.getNamespace();
        } else if (this.vlocity.sfdxUsername) {
            await this.sfdxLogin();
            await this.getNamespace();
        } else if (this.vlocity.username && this.vlocity.password) {
            await this.login();
            await this.getNamespace();
        } else {
            if (this.vlocity.passedInNamespace) {
                this.vlocity.namespace = this.vlocity.passedInNamespace;
            } else {
                this.vlocity.namespace = '%vlocity_namespace%';
            }

            VlocityUtils.verbose('Update Definitions');

            this.vlocity.datapacksutils.dataPacksExpandedDefinition = this.vlocity.datapacksutils.updateExpandedDefinitionNamespace(this.vlocity.datapacksutils.dataPacksExpandedDefinition);

            this.vlocity.PackageVersion = 'No Login';
            this.vlocity.BuildToolSettingVersion = "latest";
        }
    } catch (err) {
        VlocityUtils.verbose('Login Error: ', err);
        return err;
    }
};

UtilityService.prototype.getNamespace = async function() {
    
    VlocityUtils.verbose('Get Namespace');

    if (!this.vlocity.namespace) {
        var result;
        try {
            result = await this.vlocity.jsForceConnection.query("Select Name, NamespacePrefix from ApexClass where Name = 'DRDataPackService'");
        } catch (err) {
            if (this.vlocity.passedInNamespace) {
                VlocityUtils.verbose('Expected Namespace Failure', err, this.vlocity.passedInNamespace );
            } else if (err.code == 'ECONNRESET') {
                await this.getNamespace();
            } else {
                VlocityUtils.verbose('Namespace Query', err);
                return;
            }
        }
    
        if (result && result.records && result.records.length > 0) {
            this.vlocity.namespace = result.records[0].NamespacePrefix;
        }

        if (!this.vlocity.namespace && this.vlocity.passedInNamespace) {
            this.vlocity.namespace = this.vlocity.passedInNamespace;
        }
        
        VlocityUtils.namespace = this.vlocity.namespace;

        this.vlocity.namespacePrefix = this.vlocity.namespace ? this.vlocity.namespace + '__' : '';

        VlocityUtils.verbose('Update Definitions');

        this.vlocity.datapacksutils.dataPacksExpandedDefinition = this.vlocity.datapacksutils.updateExpandedDefinitionNamespace(this.vlocity.datapacksutils.dataPacksExpandedDefinition);

        await this.getPackageVersion();
        await this.getOrgNamespace();
    }
};

UtilityService.prototype.getPackageVersion = async function() {
    
    VlocityUtils.verbose('Get Package Version');

    if (!this.vlocity.packageVersion) {
        var result = await this.vlocity.jsForceConnection.query("SELECT DurableId, Id, IsSalesforce, MajorVersion, MinorVersion, Name, NamespacePrefix FROM Publisher where NamespacePrefix = \'" + this.vlocity.namespace + "\' LIMIT 1");

        this.vlocity.buildToolsVersionSettings = yaml.safeLoad(fs.readFileSync(path.join(__dirname, "buildToolsVersionSettings.yaml"), 'utf8'));

        this.vlocity.BuildToolSettingLatestVersion = this.vlocity.buildToolsVersionSettings.latest;

        if (!result || !result.records || result.records.length == 0) {
            this.vlocity.PackageVersion = "DeveloperOrg";
            this.vlocity.BuildToolSettingVersion = "latest";
        } else {
            this.vlocity.PackageVersion = result.records[0].MajorVersion + "." + result.records[0].MinorVersion;
            this.vlocity.PackageMajorVersion = result.records[0].MajorVersion;
            this.vlocity.PackageMinorVersion = result.records[0].MinorVersion;

            if (this.vlocity.buildToolsVersionSettings[this.vlocity.namespace]) {
                for (var i = 0; i < this.vlocity.buildToolsVersionSettings[this.vlocity.namespace].length; i++) {

                    var version = this.vlocity.buildToolsVersionSettings[this.vlocity.namespace][i];

                    if (this.vlocity.PackageMajorVersion > version.PackageMajorVersion) {
                        this.vlocity.BuildToolSettingVersion = version.version;
                        break;
                    } else if (this.vlocity.PackageMajorVersion == version.PackageMajorVersion) {
                        if (this.vlocity.PackageMinorVersion >= version.PackageMinorVersion) {
                            this.vlocity.BuildToolSettingVersion = version.version;
                            break;
                        }
                    }
                }

                if (!this.vlocity.BuildToolSettingVersion) {
                    this.vlocity.BuildToolSettingVersion = "latest";
                }
            }
        }
    }
};

UtilityService.prototype.getOrgNamespace = async function() {
    
    VlocityUtils.verbose('Get Org Namespace');

    if (!this.vlocity.orgNamespace) {
        try {
            var result = await this.vlocity.jsForceConnection.query("SELECT NamespacePrefix FROM Organization LIMIT 1");

            if (result && result.records) {
                this.vlocity.orgNamespace = result.records[0].NamespacePrefix;
            }
        }
        catch (err) {
            VlocityUtils.error('NamespacePrefix Query', err);
        }
        finally {
            if (!this.vlocity.orgNamespace) {
                this.vlocity.orgNamespace = 'No_Namespace';
            }
        }
    }
};

UtilityService.prototype.describeSObject = async function(sObjectName) {
    var self = this;
    return await new Promise(function(resolve, reject) {
        self.vlocity.jsForceConnection.sobject(self.setNamespaceToOrg(sObjectName)).describe(function(err, result) {
            if (err) {
                VlocityUtils.verbose('Describe Not found', sObjectName, err.message);
            }

            resolve(self.setNamespaceToDefault(result));
        });
    });
};

UtilityService.prototype.getFieldsDefinitionsMap = function(sObjectDescribe) {
    var fieldsDefinitionMap = {};
    
    for (var field of sObjectDescribe.fields) {
        fieldsDefinitionMap[field.name] = field; 
    }

    return fieldsDefinitionMap;
};

UtilityService.prototype.getGitDiffsFromOrgToLocal = async function(jobInfo) {
    try {
        var vbtDeployKey = `VBTDeployKey${jobInfo.gitCheckKey ? jobInfo.gitCheckKey : ''}`;
        var hashKey = await this.getVlocitySetting(vbtDeployKey);

        var changedDataPacks = [];

        if (hashKey) {
            VlocityUtils.success('Git Hash', hashKey);

            var gitChanges = childProcess.execSync(`cd ${jobInfo.projectPath} && git diff --stat ${hashKey} --raw --no-renames`, { encoding: 'utf8' });

            VlocityUtils.success('Git Differences', gitChanges);

            var allPotentialFiles = [];
            var deletedParentFiles = [];

            if (gitChanges) {
                for (var line of gitChanges.split('\n')) {
                    try {
                        if (line.length > 0 && line[0] == ':') {
    
                            var changedFile = line.substring(32);
                        
                            if (changedFile) {
                                changedFile = changedFile.trim();

                                if (line[31] == 'D' && changedFile.indexOf('_DataPack.json') != -1) {
                                    deletedParentFiles.push(changedFile)
                                } else {
                                    allPotentialFiles.push(changedFile);
                                }
                            }
                        }
                    } catch (e) {
                        VlocityUtils.error('Error Getting Filename', e);
                    }
                }    
            }

            var gitNewFiles = childProcess.execSync(`cd ${jobInfo.projectPath} && git ls-files --others --exclude-standard`, { encoding: 'utf8' });

            VlocityUtils.verbose('New Files', gitNewFiles);

            if (gitNewFiles) {
                for (var newfile of gitNewFiles.split('\n')) {
                    allPotentialFiles.push(newfile);
                }
            }

            var sfdxProjectFolder;
            try {
                if (jobInfo.includeSalesforceMetadata) {
                    sfdxProjectFolder = this.vlocity.datapacksutils.getSFDXProject(jobInfo).sfdxProject.packageDirectories[0].path;
                }
            } catch(e) {
                VlocityUtils.error(e);
            }
            
            for (var potentialFile of allPotentialFiles) {
                var dataPackKey = this.getDataPackKeyFromFilename(potentialFile, jobInfo, sfdxProjectFolder);
                if (dataPackKey && !changedDataPacks.includes(dataPackKey)) {
                    changedDataPacks.push(dataPackKey);
                }
            }

            for (var deletedFile of deletedParentFiles) {
                var dataPackKey = this.getDataPackKeyFromFilename(deletedFile, jobInfo, sfdxProjectFolder);
                if (dataPackKey && changedDataPacks.includes(dataPackKey)) {
                    VlocityUtils.log('Removing Deleted DataPack From Deploy', dataPackKey);
                    changedDataPacks.splice(changedDataPacks.indexOf(dataPackKey), 1);
                }
            }

            VlocityUtils.success('Git Check', `Found Changes for ${changedDataPacks.length} DataPacks`, changedDataPacks);
            
            return changedDataPacks;
        } else {
            VlocityUtils.error('Git Hash Not Found');
        } 
    } catch (e) {
        VlocityUtils.error('Error Getting Diffs', e);
    }

    return null;
}

UtilityService.prototype.getDataPackKeyFromFilename = function(filename, jobInfo, sfdxProjectFolder) {
       
    var splitFile = filename.split('/');

    if (splitFile.length > 2 && splitFile[splitFile.length - 1].includes('.')) {
        var dataPackKey = splitFile[splitFile.length - 3] + '/' + splitFile[splitFile.length - 2];

        if (fs.existsSync(path.join(jobInfo.projectPath, jobInfo.expansionPath, dataPackKey))) {
            return dataPackKey;
        }
    }

    if (sfdxProjectFolder) {
        if (filename.indexOf('default/') != -1) {
            
            var potentialSfdxFile = filename.substring(filename.indexOf('default/') + 8);
            var potentialSfdxFileSplit = potentialSfdxFile.split('/');

            var dataPackKey;

            if (potentialSfdxFileSplit[0] == 'objects' && potentialSfdxFileSplit.length == 4) {
                dataPackKey = potentialSfdxFileSplit[0] + '/' + potentialSfdxFileSplit[1] + '/' + potentialSfdxFileSplit[2] + '/' + potentialSfdxFileSplit[3];
            } else {
                dataPackKey = potentialSfdxFileSplit[0] + '/' + potentialSfdxFileSplit[1];
            }

            if (fs.existsSync(path.join(jobInfo.projectPath, sfdxProjectFolder, 'main', 'default', dataPackKey))) {
                return dataPackKey;
            }
        }
    }

    return null;
}

UtilityService.prototype.setVlocitySetting = async function(settingName, value) {
    try {    
        let result = await this.vlocity.jsForceConnection.query(`Select Id, ${this.vlocity.namespace}__Value__c from ${this.vlocity.namespace}__GeneralSettings__c where Name = '${settingName}'`);

        var settingsRecord = {};
        settingsRecord.Name = settingName;
        settingsRecord[`${this.vlocity.namespace}__Value__c`] = value;

        if (result && result.records.length != 0) {
            settingsRecord.Id = result.records[0].Id;
        }

        if (settingsRecord.Id) {
            VlocityUtils.verbose('Set Setting Update', await this.vlocity.jsForceConnection.sobject(`${this.vlocity.namespace}__GeneralSettings__c`).update([ settingsRecord ], {}));
        } else {
            VlocityUtils.verbose('Set Setting Insert', await this.vlocity.jsForceConnection.sobject(`${this.vlocity.namespace}__GeneralSettings__c`).insert([ settingsRecord ], {}));
        }
    } catch (e) {
        VlocityUtils.error('Set Settings Error', e);
    }

    return null;
}

UtilityService.prototype.getVlocitySetting = async function(settingName) {
    try {    
        let result = await this.vlocity.jsForceConnection.query(`Select ${this.vlocity.namespace}__Value__c from ${this.vlocity.namespace}__GeneralSettings__c where Name = '${settingName}'`);

        if (result && result.records.length != 0) {
            return result.records[0][`${this.vlocity.namespace}__Value__c`];
        }
    } catch (e) {
        VlocityUtils.error('Get Settings Error', e);
    }

    return null;
}

UtilityService.prototype.sfdx = async function(command, options) {
    var org = {
        getUsername: function() {
            return options.targetusername;
        }
    };

    var flags = options;
    let sfdxCommand;

    flags.quiet = VlocityUtils.quiet;
    flags.json = VlocityUtils.quiet;

    try {
        if (command == 'org:display') {
            var OrgDisplayCommand = require("salesforce-alm/dist/commands/force/org/display");
            sfdxCommand = new OrgDisplayCommand.OrgDisplayCommand();
        } else if (command == 'source:retrieve') {
            var SourceRetrieveCommand = require("salesforce-alm/dist/commands/force/source/retrieve");
            sfdxCommand = new SourceRetrieveCommand.SourceRetrieveCommand();
        } else if (command == 'source:deploy') {
            var SourceDeployCommand = require("salesforce-alm/dist/commands/force/source/deploy");
            sfdxCommand = new SourceDeployCommand.SourceDeployCommand();
            sfdxCommand.ux = await require("@salesforce/command").UX.create();
        } else if (command == 'source:delete') {
            var SourceDeleteCommand = require("salesforce-alm/dist/commands/force/source/delete");
            sfdxCommand = new SourceDeleteCommand.SourceDeleteCommand();
            sfdxCommand.ux = await require("@salesforce/command").UX.create();
        }

        sfdxCommand.flags = flags;
        sfdxCommand.org = org;
        return await sfdxCommand.run();
    } catch (e) {
        VlocityUtils.error(JSON.stringify(e, null, 4));

        if (command == 'source:deploy' && e.data) {
            throw e.data;
        }

        throw e; 
    }
}


UtilityService.prototype.updateCustomObject = async function(metadata) {
    return await this.updateMetadata('CustomObject', metadata);
};

UtilityService.prototype.retrieveCustomObject = async function(sObjectAPIName) {
    return await this.retrieveMetadata('CustomObject', sObjectAPIName);
};

UtilityService.prototype.updateGlobalValueSet = async function(metadata) {
    return await this.updateMetadata('GlobalValueSet', metadata);
};

UtilityService.prototype.retrieveGlobalValueSet = async function(sObjectAPIName) {
    return await this.retrieveMetadata('GlobalValueSet', sObjectAPIName);
};

UtilityService.prototype.retrieveMetadata = async function(type, component) {
    if (type && component) {
        component = this.vlocity.utilityservice.setNamespaceToOrg(component);

        try {
            var result = await this.vlocity.jsForceConnection.metadata.read(type, component);
            return this.vlocity.utilityservice.setNamespaceToDefault(result);
        } catch (e) {
            VlocityUtils.error('Retrieve Failed', e.message);
        }
    }
};

UtilityService.prototype.updateMetadata = async function(type, metadata) { 
    if (metadata && !this.isEmptyObject(metadata)) {
        metadata = this.vlocity.utilityservice.setNamespaceToOrg(metadata);
      
        try {
            var result = await this.vlocity.jsForceConnection.metadata.update(type, metadata);
        
            if (!(result instanceof Array)) {
                result = [result];
            }
    
            for (var res of result) {
                if (!res.success) {
                    VlocityUtils.error('Error Update Metadata', res.errors);
                }
            }
            
            return this.vlocity.utilityservice.setNamespaceToDefault(result);
        } catch (err) {
            VlocityUtils.error('Error Update Metadata', err);
        }        
    }
}

UtilityService.prototype.createOrUpdateGitIgnoreFile = async function (jobInfo) {

    var gitIgnorePath = path.join(jobInfo.localRepoPath, '.gitignore');

    if (fs.existsSync(gitIgnorePath)) {
        return;
    }

    var ignoreFile = fs.openSync(gitIgnorePath, 'w');
    fs.writeSync(ignoreFile, "\nVlocityBuild*\nvlocity-temp/\n");
    fs.closeSync(ignoreFile);
}

UtilityService.prototype.runGitCheckoutBranch = async function (jobInfo) {

    if(!jobInfo.enableFullGitSupport) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Please set enableFullGitSupport to true in job file settings');
        VlocityUtils.error('Please set enableFullGitSupport to true in job file settings');
        return;
    }

    if (!jobInfo.branchName) {
        jobInfo.hasError = true;
        jobInfo.errors.push('branch name not entered');
        VlocityUtils.error('branch name not entered');
        return;
    }

    if (!jobInfo.localRepoPath) {
        jobInfo.localRepoPath = jobInfo.projectPath;
    }

    try {
        if (jobInfo.createNewBranch) {
            if (jobInfo.branchStartPoint) {
                let result = await gitP(jobInfo.localRepoPath).checkoutBranch(jobInfo.branchName, jobInfo.branchStartPoint);
            }
            else {
                let result = await gitP(jobInfo.localRepoPath).checkoutBranch(jobInfo.branchName, 'master');
            }
        }
        else {
            let result = await gitP(jobInfo.localRepoPath).checkout([jobInfo.branchName]);
        }
    }
    catch (err) {
        VlocityUtils.error(err);
        jobInfo.hasError = true;
        jobInfo.errors.push(err);
    }

}

UtilityService.prototype.runGitCurrentBranch = async function (jobInfo) {

    if (!jobInfo.enableFullGitSupport) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Please set enableFullGitSupport to true in job file settings');
        VlocityUtils.error('Please set enableFullGitSupport to true in job file settings');
        return;
    }

    if (!jobInfo.localRepoPath) {
        jobInfo.localRepoPath = jobInfo.projectPath;
    }

    try {
        let result = await gitP(jobInfo.localRepoPath).raw(['rev-parse', '--abbrev-ref', 'HEAD']);
        if (result) {
            jobInfo.data = result;
        }
    }
    catch (err) {
        jobInfo.hasError = true;
        jobInfo.errors.push(err);
    }

    return jobInfo.data;
}

UtilityService.prototype.initialiseRepo = async function (jobInfo, git) {
    var self = this;

    await git.init();
    
    if(jobInfo.gitRemoteUrl) {
        git.addRemote('origin', jobInfo.gitRemoteUrl);
    }

    self.createOrUpdateGitIgnoreFile(jobInfo);
}

UtilityService.prototype.runGitInit = async function (jobInfo) {

        var self = this;

        if (!jobInfo.enableFullGitSupport) {
            jobInfo.hasError = true;
            jobInfo.errors.push('Please set enableFullGitSupport to true in job file settings');
            VlocityUtils.error('Please set enableFullGitSupport to true in job file settings');
            return;
        }

        if (!jobInfo.localRepoPath) {
            jobInfo.localRepoPath = jobInfo.projectPath;
        }

        if (!fs.existsSync(jobInfo.localRepoPath)) {
            fs.mkdirSync(jobInfo.localRepoPath);
        }

        var git = gitP(jobInfo.localRepoPath);

        var isRepo = await git.checkIsRepo()
        
        if(!isRepo) { 
            await self.initialiseRepo(jobInfo, git);
        }
            
        git.fetch();
}

UtilityService.prototype.runGitCommit = async function (jobInfo) {

    var self = this;
    var commitPath = path.join(jobInfo.projectPath, jobInfo.expansionPath);
    var results = [];

    if(!jobInfo.enableFullGitSupport) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Please set enableFullGitSupport to true in job file settings');
        VlocityUtils.error('Please set enableFullGitSupport to true in job file settings');
        return;
    }

    if(!jobInfo.commitMessage) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Commit Message not entered');
        VlocityUtils.error('Commit Message not entered');
        return;
    }

    if (!jobInfo.localRepoPath) {
        jobInfo.localRepoPath = jobInfo.projectPath;
    }
    await self.runGitInit(jobInfo);

    this.ignoreTerminalPrompt(jobInfo.appPath);
    jobInfo.data = jobInfo.manifest;
    

    if (Array.isArray(jobInfo.manifest)) {

        var sfdxProject = this.vlocity.datapacksutils.getSFDXProject(jobInfo);

        var sfdxFolder;

        if (sfdxProject) {
            sfdxFolder = sfdxProject.sfdxProject.packageDirectories[0].path;
        }
       
        for (var fileOrFolderName of jobInfo.manifest) {
            if (sfdxFolder && fs.existsSync(path.join(sfdxProject.sfdxPath, sfdxFolder, 'main', 'default', fileOrFolderName))) {
                await simpleGit(jobInfo.localRepoPath).add(path.join(sfdxProject.sfdxPath, sfdxFolder, 'main', 'default', fileOrFolderName));
            } else {
                var sanitizedFileorFoldername = unidecode(fileOrFolderName)
                    .replace("\\", "-")
                    .replace(/[^A-Za-z0-9/_\-]+/g, "-")
                    .replace(/[-]+/g, "-")
                    .replace(/[-_]+_/g, "_")
                    .replace(/[-]+\/[-]+/g, "/")
                    .replace(/^[-_\\/]+/, "")
                    .replace(/[-_\\/]+$/, "");

                var dirPath = path.join(commitPath, sanitizedFileorFoldername);

                try {
                    if (fs.lstatSync(dirPath).isDirectory()) {
                        var files = [];
                        files = self.vlocity.datapacksutils.getFiles(dirPath);
                        for (file in files) {
                            await simpleGit(jobInfo.localRepoPath).add(path.join(dirPath, files[file]));
                        }
                        results.push(jobInfo.manifest[fileOrFolderName]);
                    }
                } catch (err) {
                    VlocityUtils.error('Error during Commit', err);
                    jobInfo.hasError = true;
                }
            }
        }
    } else {
        await simpleGit(jobInfo.localRepoPath).add(path.join(commitPath, sanitizedFileorFoldername));
        results.push([jobInfo.manifest]);
    }

    try {
        let result = await gitP(jobInfo.localRepoPath).commit(jobInfo.commitMessage);

        if(!result.commit) {
            jobInfo.hasError = true;
            jobInfo.errors.push('Not Committed');
        }
        else {
            jobInfo.message = 'Committed';
        }
    }
    catch (err) {
        await gitP(jobInfo.localRepoPath).reset(['HEAD']);
        jobInfo.hasError = true;
        jobInfo.errors.push(err);
    }

}

UtilityService.prototype.runGitPush = async function (jobInfo) {

    if(!jobInfo.enableFullGitSupport) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Please set enableFullGitSupport to true in job file settings');
        VlocityUtils.error('Please set enableFullGitSupport to true in job file settings');
        return;
    }

    if (!jobInfo.localRepoPath) {
        jobInfo.localRepoPath = jobInfo.projectPath;
    }

    if (!jobInfo.targetBranch) {
        await simpleGit(jobInfo.localRepoPath).addConfig('push.default', 'current');
    }

    this.ignoreTerminalPrompt(jobInfo.appPath);

    try {
        let result = await gitP(jobInfo.localRepoPath).push('origin', jobInfo.targetBranch, { '-f': null });
    }
    catch (err) {
        jobInfo.hasError = true;
        jobInfo.errors.push(err);
    }
}

UtilityService.prototype.runGitClone = async function (jobInfo) {

    var self = this;
    if(!jobInfo.enableFullGitSupport) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Please set enableFullGitSupport to true in job file settings');
        VlocityUtils.error('Please set enableFullGitSupport to true in job file settings');
        return;
    }

    if (!jobInfo.gitRemoteUrl) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Remote URL not entered');
        VlocityUtils.error('Remote URL not entered');
        return;
    }

    if (!jobInfo.localRepoPath) {
        jobInfo.localRepoPath = jobInfo.projectPath;
    }

    this.ignoreTerminalPrompt(jobInfo.appPath);

    try {
        await gitP().clone(jobInfo.gitRemoteUrl, jobInfo.localRepoPath);
    }
    catch (err) {
        jobInfo.hasError = true;
        jobInfo.errors.push(err);
    }

    self.createOrUpdateGitIgnoreFile(jobInfo);

}

UtilityService.prototype.runGitPull = async function (jobInfo) {

    if (!jobInfo.enableFullGitSupport) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Please set enableFullGitSupport to true in job file settings');
        VlocityUtils.error('Please set enableFullGitSupport to true in job file settings');
        return;
    }

    if (!jobInfo.branchName) {
        jobInfo.branchName = await this.runGitCurrentBranch(jobInfo);
    }

    this.ignoreTerminalPrompt(jobInfo.appPath);

    jobInfo.branchName = jobInfo.branchName.replace("remotes/origin/","");

    try {
        await gitP(jobInfo.localRepoPath).fetch();
        let mergeResult = await gitP(jobInfo.localRepoPath).merge(['origin', jobInfo.branchName]);
        VlocityUtils.verbose('Merge summary', mergeResult);
    }
    catch (err) {
        jobInfo.hasError = true;
        jobInfo.errors.push(err);
    }
}

UtilityService.prototype.runGitBranch = async function (jobInfo) {

    if (!jobInfo.enableFullGitSupport) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Please set enableFullGitSupport to true in job file settings');
        VlocityUtils.error('Please set enableFullGitSupport to true in job file settings');
        return;
    }

    if (!jobInfo.localRepoPath) {
        jobInfo.localRepoPath = jobInfo.projectPath;
    }

    try {
        let result = await gitP(jobInfo.localRepoPath).branch(['-a']);
        jobInfo.data = result.all;
    }
    catch (err) {
        jobInfo.hasError = true;
        jobInfo.errors.push(err);
    }

    return jobInfo.data;
}

UtilityService.prototype.runGitCheckRepo = async function (jobInfo) {

    var self = this;

    if (!jobInfo.enableFullGitSupport) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Please set enableFullGitSupport to true in job file settings');
        VlocityUtils.error('Please set enableFullGitSupport to true in job file settings');
        return;
    }

    if (!jobInfo.localRepoPath) {
        jobInfo.localRepoPath = jobInfo.projectPath;
    }

    var git = gitP(jobInfo.localRepoPath);

    jobInfo.data = await git.checkIsRepo();
}

UtilityService.prototype.matchingKeysCheckUpdate = async function(jobInfo) {
    var queriesList = await this.buildQueriesMatchingKeys();
    var duplicatesMap = await this.queryDuplicates(queriesList, jobInfo);
    await this.updateDuplicateRecords(jobInfo, duplicatesMap);
};

UtilityService.prototype.runGitStatus = async function (jobInfo) {

    var self = this;

    if (!jobInfo.enableFullGitSupport) {
        jobInfo.hasError = true;
        jobInfo.errors.push('Please set enableFullGitSupport to true in job file settings');
        VlocityUtils.error('Please set enableFullGitSupport to true in job file settings');
        return;
    }

    if (!jobInfo.localRepoPath) {
        jobInfo.localRepoPath = jobInfo.projectPath;
    }

    try {
        let result = await gitP(jobInfo.localRepoPath).raw(['status']);
        jobInfo.data = JSON.stringify(result);
    }
    catch (err) {
        jobInfo.hasError = true;
        jobInfo.errors.push(err);
    }
}

UtilityService.prototype.checkDuplicates = async function(inputMap) {
    var queryResult;
    var jobInfo = inputMap.jobInfo;
    var duplicatesMap = inputMap.duplicatesMap;

    try {
        queryResult = await this.vlocity.queryservice.query(inputMap.query);

        if (queryResult && queryResult.records.length > 0) {
            var uniqueKeys = {};
    
            for (var i = 0; i < queryResult.records.length; i++) {
                var lastModifiedDate = queryResult.records[i]['LastModifiedDate'];
                
                var skipFields = ['Id'];
                var deleteFields = ['LastModifiedDate', 'attributes'];
                var matchingKeyValue = '';
    
                for (var field in queryResult.records[i]) {
                    if (deleteFields.includes(field)) {
                        delete queryResult.records[i][field];
                        continue;
                    } else if (skipFields.includes(field)) {
                        continue;
                    }
    
                    if (queryResult.records[i][field] === null
                        && field === '%vlocity_namespace%__GlobalKey__c') {
                        if (!duplicatesMap[inputMap.sObjectType]) {
                            duplicatesMap[inputMap.sObjectType] = {};
                        }
    
                        var globalKey = this.vlocity.datapacksutils.guid();
                        queryResult.records[i][field] = globalKey;
                        duplicatesMap[inputMap.sObjectType][globalKey] = queryResult.records[i];
    
                        VlocityUtils.report('Adding GlobalKey', 'Record: ' + queryResult.records[i]['Id']);
                        jobInfo.report.push('Adding GlobalKey >> ' + 'Record: ' + queryResult.records[i]['Id']);
                    }
    
                    matchingKeyValue += `Field: ${field} Value: ${queryResult.records[i][field]} `;
                }
    
                if (uniqueKeys.hasOwnProperty(matchingKeyValue)) {
                    if (uniqueKeys[matchingKeyValue]['LastModifiedDate'] < lastModifiedDate) {
                        uniqueKeys[matchingKeyValue]['LastModifiedDate'] = lastModifiedDate;
                    }
    
                    if (!duplicatesMap[inputMap.sObjectType]) {
                        duplicatesMap[inputMap.sObjectType] = {};
                    }
                    
                    duplicatesMap[inputMap.sObjectType][matchingKeyValue] = uniqueKeys[matchingKeyValue];

                    var message = `SObjectType: ${inputMap.sObjectType} - Record Ids: ${uniqueKeys[matchingKeyValue]['Id']},${queryResult.records[i].Id} - Matching Info: ${matchingKeyValue}`;
                    VlocityUtils.report('Duplicate Found', message);
                    jobInfo.report.push(`Duplicate - ${message}`);
                } else {
                    uniqueKeys[matchingKeyValue] = queryResult.records[i];
                }
            }
        }
    } catch (e) {
        VlocityUtils.error('Query Failed', e.message);
    }
};

UtilityService.prototype.queryDuplicates = async function(queriesList, jobInfo) {
    var duplicatesMap = {};
    var queryPromises = [];

    for (var query of queriesList) {
        queryPromises.push({ context: this, argument: { sObjectType: query.sObjectType, query: query.fullQuery, duplicatesMap: duplicatesMap, jobInfo: jobInfo }, func: 'checkDuplicates' });
    }

    await this.parallelLimit(queryPromises);
    return duplicatesMap;
};

UtilityService.prototype.getAllValidSObjects = async function() {

    if (!this.getAllValidSObjectsValues) {
        let metaList = await this.vlocity.jsForceConnection.metadata.list([{ type: 'CustomObject', folder: null }, ], VLOCITY_BUILD_SALESFORCE_API_VERSION);
        this.getAllValidSObjectsValues = {};

        for (var meta of metaList) {
            this.getAllValidSObjectsValues[meta.fullName.replace(this.vlocity.namespace, '%vlocity_namespace%')] = meta;
        }
    }

    return this.getAllValidSObjectsValues;
}

UtilityService.prototype.buildQueriesMatchingKeys = async function() {
    var vlocityMatchingKeys = await this.getDRMatchingKeyFields();
    var queriesList = [];
    var excludeObjects = [ 'User', 'PricebookEntry', 'Account', 'Attachment', 'RecordType', '%vlocity_namespace%__DRMapItem__c', '%vlocity_namespace%__Element__c' ];

    var getAllValidSObjects = await this.getAllValidSObjects();

    for (var objectName of excludeObjects) {
        if (vlocityMatchingKeys.hasOwnProperty(objectName) || getAllValidSObjects.hasOwnProperty(objectName)) {
            delete vlocityMatchingKeys[objectName];
        }
    }

    for (var sObjectType in vlocityMatchingKeys) {

        if (sObjectType.indexOf('__c') != -1 && !getAllValidSObjects.hasOwnProperty(sObjectType)) {
            continue;
        }

        var fields = vlocityMatchingKeys[sObjectType];
        var queryBase = 'Id,LastModifiedDate,';

        if (fields) {
            queryBase += fields;
            var queryString = this.vlocity.queryservice.buildSOQL(queryBase, sObjectType);      
            var queryObject = { sObjectType : sObjectType, fullQuery: queryString };
            
            queriesList.push(queryObject);
        }
    }

    return queriesList;
};

UtilityService.prototype.updateDuplicateRecords = async function(jobInfo, duplicatesMap) {
    if (!this.isEmptyObject(duplicatesMap)) {
        for (var sObjectType in duplicatesMap) {
            var updateSObjects = [];

            for (var uniqueKey in duplicatesMap[sObjectType]) {
                if (!duplicatesMap[sObjectType][uniqueKey].hasOwnProperty('%vlocity_namespace%__GlobalKey__c') 
                    || Object.keys(duplicatesMap[sObjectType][uniqueKey]).length !== 2) {
                    break;
                }

                var newValue = this.vlocity.datapacksutils.guid();

                duplicatesMap[sObjectType][uniqueKey]['%vlocity_namespace%__GlobalKey__c'] = newValue;
                updateSObjects.push(duplicatesMap[sObjectType][uniqueKey]);

                var message = 'Record: ' + duplicatesMap[sObjectType][uniqueKey]['Id'] + ' with GlobalKey__c updated with value: ' + newValue;
                VlocityUtils.success('GlobalKey Fixed', message);
                jobInfo.report.push('GlobalKey Fixed >> ' + message);
            }

            if (!this.isEmptyObject(updateSObjects)) {
                await this.updateSObjectsBulk(sObjectType, updateSObjects);
            }
        }
    }
};

UtilityService.prototype.updateBulk = async function(inputMap) {
    await this.updateSObject(inputMap.sObjectType, inputMap.sObject);
};

UtilityService.prototype.updateSObjectsBulk = async function(sObjectType, updateSObjects) {
    var queryPromises = [];

    for (var sObject of updateSObjects) {
        queryPromises.push({ context: this, argument: { sObjectType: sObjectType, sObject: sObject }, func: 'updateBulk' });
    }

    await this.parallelLimit(queryPromises, 5);
};

UtilityService.prototype.ignoreTerminalPrompt = async function (dirname) {
    childProcess.execSync(`cd ${dirname}`);
    process.env.GIT_TERMINAL_PROMPT = 0;
}

UtilityService.prototype.getVisualForcePageUrl = function (dataPackType, datapackId) {
    let designerPath = '',
        urlTemplate = this.vlocity.datapacksutils.getVisualForcePagetemplate(dataPackType);
    if(urlTemplate){
        designerPath =  urlTemplate[0].replace(/%vlocity_namespace%__/g,this.vlocity.namespacePrefix).replace('%Id%',datapackId);
    } else {
        designerPath = '/' + datapackId;
    }
    return this.vlocity.jsForceConnection.instanceUrl + '/secur/frontdoor.jsp?sid=' + this.vlocity.jsForceConnection.accessToken + '&retURL=' + designerPath;
}

UtilityService.prototype.filterForVersionQueries = function (queryDefinitions, jobInfo) {
    if(jobInfo.versionCompare){
        jobInfo.queries = [];
        Object.keys(queryDefinitions).forEach(key => {
            if(queryDefinitions[key].versionCompare){
                jobInfo.queries.push(key);
            } else {
                delete queryDefinitions[key]
            }
        });
    } else {
        Object.keys(queryDefinitions).forEach( key => {
            if(queryDefinitions[key].versionCompare){
                delete queryDefinitions[key];
            }
        });
    }

    if(jobInfo.versionExport && jobInfo.manifest && jobInfo.manifest[0]){
        jobInfo.queries = [];
        Object.keys(queryDefinitions).forEach( key => {
            let queryObj = queryDefinitions[key];
            if(queryObj.versionExport && jobInfo.manifest[0].indexOf(queryObj.VlocityDataPackType) != -1){
                queryObj.query = queryObj.query.replace('%'+jobInfo.manifest[0].split('/')[0]+'Id%',"'" + jobInfo.manifest[0].split('/')[1] + "'");
                if(!this.vlocity.namespace && queryObj.query.includes('%vlocity_namespace%__')){
                    queryObj.query = queryObj.query.replace(/%vlocity_namespace%__/g,'');
                }
                jobInfo.queries.push(queryObj);
            }
        });
    } else {
        Object.keys(queryDefinitions).forEach( key => {
            if(key.includes('VersionExport')){
                delete queryDefinitions[key];
            }
        });
    }
    return {queryDefinitions: queryDefinitions, jobInfo: jobInfo};
}