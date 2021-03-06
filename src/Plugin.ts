import { CLI, Hooks, Serverless, ServerlessPlugin, ServerlessProvider } from "@xapp/serverless-plugin-type-definitions";
import { CloudFormation, config as AWSConfig, SharedIniFileCredentials, STS } from "aws-sdk";
import * as Path from "path";
import { AWSOptions } from "request";
import * as Request from "request-promise-native";
import { findCloudformationExport, parseConfigObject } from "./AwsUtils";
import Config, { Index, Template } from "./Config";
import { getProfile, getProviderName, getRegion, getStackName } from "./ServerlessObjUtils";
import { setupRepo } from "./SetupRepo";

interface Custom {
    elasticsearch?: Config;
}

class Plugin implements ServerlessPlugin {

    private serverless: Serverless<Custom>;
    private cli: CLI;
    hooks: Hooks;

    constructor(serverless: Serverless<Custom>, context: any) {
        this.serverless = serverless;
        this.cli = serverless.cli;

        this.hooks = {
            "before:aws:deploy:deploy:updateStack": this.validate.bind(this),
            "after:aws:deploy:deploy:updateStack": this.setupElasticCache.bind(this)
        };
    }

    /**
     * Creates the plugin with the fully parsed Serverless object.
     */
    private async validate() {
        const custom = this.serverless.service.custom || {};
        const config = custom.elasticsearch || {};

        if (!config.endpoint && !config["cf-endpoint"]) {
            throw new Error("Elasticsearch endpoint not specified.");
        }
    }

    /**
     * Sends the mapping information to elasticsearch.
     */
    private async setupElasticCache() {
        const serviceName = await getProviderName(this.serverless);
        const profile = getProfile(this.serverless);
        const region = getRegion(this.serverless);

        const requestOptions: Partial<Request.Options> = {};
        if (serviceName === "aws") {
            AWSConfig.credentials = new SharedIniFileCredentials({ profile });
            AWSConfig.region = region;
            requestOptions.aws = {
                key: AWSConfig.credentials.accessKeyId,
                secret: AWSConfig.credentials.secretAccessKey,
                sign_version: 4
            } as AWSOptions; // The typings are wrong.  It need to include "key" and "sign_version"
        }

        const config = await parseConfig(this.serverless);
        const endpoint = config.endpoint.startsWith("http") ? config.endpoint : `https://${config.endpoint}`;

        this.cli.log("Setting up templates...");
        await setupTemplates(endpoint, config.templates, requestOptions);
        this.cli.log("Setting up indices...");
        await setupIndices(endpoint, config.indices, requestOptions);
        this.cli.log("Setting up repositories...");
        await setupRepo({
            baseUrl: endpoint,
            sts: new STS(),
            repos: config.repositories,
            requestOptions
        });
        this.cli.log("Elasticsearch setup complete.");
    }
}

/**
 * Parses the config object so all attributes are usable values.
 *
 * If the user has defined "cf-Endpoint" then the correct value will be moved to "endpoint".
 *
 * @param serverless
 */
async function parseConfig(serverless: Serverless<Custom>): Promise<Config> {
    const provider = serverless.service.provider || {} as Partial<ServerlessProvider>;
    const custom = serverless.service.custom || {};
    let config = custom.elasticsearch || {} as Config;

    if (provider.name === "aws" || config["cf-endpoint"]) {
        const cloudFormation = new CloudFormation();

        config = await parseConfigObject(cloudFormation, getStackName(serverless), config);

        if (config["cf-endpoint"]) {
            config.endpoint = await findCloudformationExport(cloudFormation, config["cf-endpoint"]);
            if (!config.endpoint) {
                throw new Error("Endpoint not found at cloudformation export.");
            }
        }
    }

    return config;
}

/**
 * Sets up all the indices in the given object.
 * @param baseUrl The elasticsearch URL
 * @param indices The indices to set up.
 */
function setupIndices(baseUrl: string, indices: Index[] = [], requestOptions?: Partial<Request.Options>) {
    const setupPromises: PromiseLike<Request.FullResponse>[] = indices.map((index) => {
        validateIndex(index);
        const url = `${baseUrl}/${index.name}`;
        const settings = require(Path.resolve(index.file));
        return esPut(url, settings, requestOptions).catch((e) => {
            if (e.error.error.type !== "resource_already_exists_exception") {
                throw e;
            }
        });
    });
    return Promise.all(setupPromises);
}

function validateIndex(index: Index) {
    if (!index.name) {
        throw new Error("Index does not have a name.");
    }
    if (!index.file) {
        throw new Error("Index does not have a file location.");
    }
}

/**
 * Sets up all the index templates in the given object.
 * @param baseUrl The elasticsearch URL
 * @param templates The templates to set up.
 */
function setupTemplates(baseUrl: string, templates: Template[] = [], requestOptions?: Partial<Request.Options>) {
    const setupPromises: PromiseLike<Request.FullResponse>[] = templates.map((template) => {
        validateTemplate(template);
        const url = `${baseUrl}/_template/${template.name}`;
        const settings = require(Path.resolve(template.file));
        return esPut(url, settings, requestOptions);
    });
    return Promise.all(setupPromises);
}

function validateTemplate(template: Template) {
    if (!template.name) {
        throw new Error("Template does not have a name.");
    }
    if (!template.file) {
        throw new Error("Template does not have a file location.");
    }
}

function esPut(url: string, settings: object, requestOpts?: Partial<Request.Options>) {
    const headers = {
        "Content-Type": "application/json",
    };
    return Request.put(url, {
        headers,
        json: settings,
        ...requestOpts
    });
}

export default Plugin;