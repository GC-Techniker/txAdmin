//Requires
const modulename = 'Deployer';
const YAML = require('js-yaml');
const fs = require('fs-extra');
const dateFormat = require('dateformat');
const { dir, log, logOk, logWarn, logError } = require('../extras/console')(modulename);
const recipeEngine = require('./recipeEngine');

//Helper functions
const getTimestamp = () => { return dateFormat(new Date(), 'HH:MM:ss') };
const isUndefined = (x) => { return (typeof x === 'undefined') };
const toDefault = (input, defVal) => { return (isUndefined(input))? defVal : input };
const canCreateFile = async (targetPath) => {
    try {
        await fs.outputFile(path.join(targetPath, '.empty'), '#save_attempt_please_ignore');
        return true;
    } catch (error) {
        return false;
    }
}


/**
 * Perform deployer local target path permission/emptiness checking
 * FIXME: timeout to remove folders, or just autoremove them idk
 * @param {*} path 
 */
const validateTargetPath = async (deployPath) => {
    if(deployPath.includes(' ')) throw new Error(`The paths cannot contain spaces.`);

    if(await fs.pathExists(deployPath)){
        const pathFiles = await fs.readdir(deployPath);
        if(pathFiles.some(x => x !== '.empty')){
            throw new Error(`This folder is not empty!`);
        }else{
            if(await canCreateFile(deployPath)){
                //remove folder
                return `Exists, empty, and writtable!`;
            }else{
                throw new Error(`Path exists, but its not a folder, or its not writtable.`);
            }
        }
    }else{
        if(await canCreateFile(deployPath)){
            //remove folder
            return `Path didn't existed, we created one.`;
        }else{
            throw new Error(`Path doesn't exist, and we could not create it. Please check parent folder permissions.`);
        }
    }
}


/**
 * Validates a Recipe file
 * TODO: use Joi for schema validaiton
 * @param {*} rawRecipe 
 */
const parseValidateRecipe = (rawRecipe) => {
    if(typeof rawRecipe !== 'string') throw new Error(`not a string`);
    
    //Loads YAML
    let recipe;
    try {
        recipe = YAML.safeLoad(rawRecipe, { schemax: YAML.JSON_SCHEMA });   
    } catch (error) {
        if(GlobalData.verbose) dir(error);
        throw new Error(`invalid yaml`);
    }

    //Basic validation
    if(typeof recipe !== 'object') throw new Error(`invalid YAML, couldn't resolve to object`);
    if(!Array.isArray(recipe.tasks)) throw new Error(`no tasks array found`);

    //Preparing output
    const outRecipe = {
        raw: rawRecipe.trim(),
        name: toDefault(recipe.name, 'unnamed').trim(),
        version: toDefault(recipe.version, '').trim(),
        author: toDefault(recipe.author, 'unknown').trim(),
        description: toDefault(recipe.description, '').trim(),
        tasks: []
    };

    //Checking meta tag requirements
    if(typeof recipe['$minFxVersion'] == 'number'){
        if(recipe['$minFxVersion'] > GlobalData.fxServerVersion) throw new Error(`this recipe requires FXServer v${recipe['$minFxVersion']} or above`);
        outRecipe.fxserverMinVersion = recipe['$minFxVersion']; //useless for now
    }
    if(typeof recipe['$engine'] == 'number'){
        if(recipe['$engine'] !== 1) throw new Error(`unsupported '$engine' version ${recipe['$engine']}`);
        outRecipe.recipeEngineVersion = recipe['$engine']; //useless for now
    }else{
        outRecipe.recipeEngineVersion = 1;
    }

    //Validate tasks
    recipe.tasks.forEach((task, index) => {
        if(typeof task.action !== 'string') throw new Error(`[task${index+1}] no action specified`);
        if(typeof recipeEngine[task.action] === 'undefined') throw new Error(`[task${index+1}] unknown action '${task.action}'`);
        if(!recipeEngine[task.action].validate(task)) throw new Error(`[task${index+1}:${task.action}] invalid parameters`);
        outRecipe.tasks.push(task)
    });

    if(GlobalData.verbose) dir(outRecipe);
    return outRecipe;
}


/**
 * The deployer class is responsible for running the recipe and handling status and errors
 * FIXME: add some logging (terminal)
 * FIXME: log everything to deployPath/recipe.log
 */
class Deployer {
    /**
     * @param {string} originalRecipe 
     * @param {string} deployPath 
     * @param {boolean} isTrustedSource 
     */
    constructor(originalRecipe, deployPath, isTrustedSource) {
        log('Deployer instance ready.');
        
        //Setup variables        
        this.step = 'review';
        this.deployFailed = false;
        this.deployPath = deployPath;
        this.isTrustedSource = isTrustedSource;
        this.originalRecipe = originalRecipe;
        this.progress = 0;
        this.logLines = [];

        //Load recipe
        try {
            this.recipe = parseValidateRecipe(originalRecipe);
        } catch (error) {
            throw new Error(`Recipe Error: ${error.message}`);
        }
    }

    //Dumb helpers - don't care enough to make this less bad
    log(str){
        this.logLines.push(`[${getTimestamp()}] ${str}`);
        log(str);
    }
    logError(str){
        this.logLines.push(`[${getTimestamp()}] ${str}`);
        logError(str);
    }
    getLog(){
        return this.logLines.join('\n');
    }

    /**
     * Starts the deployment process
     * @param {string} userRecipe 
     */
    start(userRecipe){
        try {
            this.recipe = parseValidateRecipe(userRecipe);
        } catch (error) {
            throw new Error(`Cannot start() deployer due to a Recipe Error: ${error.message}`);
        }
        this.logLines = [];
        this.log(`Starting deployment...`);
        this.deployFailed = false;
        this.progress = 0;
        this.step = 'run';
        this.runTasks();
    }

    /**
     * (Private) Run the tasks in a sequential way.
     */
    async runTasks(){
        for (let index = 0; index < this.recipe.tasks.length; index++) {
            this.progress = Math.round((index/this.recipe.tasks.length)*100);

            const task = this.recipe.tasks[index];
            const taskID = `[task${index+1}:${task.action}]`;
            this.log.push(`Running ${taskID}...`);
            log(`Running ${taskID}`);

            try {
                await recipeEngine[task.action].run(task, this.deployPath)
                this.log[this.log.length -1] += ` ✔️`;
            } catch (error) {
                this.log[this.log.length -1] += ` ❌`;
                const msg = `${taskID} failed with message: \n${error.message}`;
                logError(msg);
                this.log.push(msg)
                this.deployFailed = true;
                return;
            }
        }

        this.progress = 100;
        this.log.push(`All tasks done!`)
        logOk(`All tasks done!`)
        this.step = 'configure';
    }
} //Fim Deployer()


module.exports = {
    Deployer,
    validateTargetPath,
    parseValidateRecipe
}