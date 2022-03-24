const _ = require('lodash');
const crypto = require('crypto')
const fs = require('fs')
const { debug, log } = require('winston');
const GenerateSchema = require('generate-schema')

const md5 = string => crypto.createHash('md5').update(string).digest('hex')

var swagger = {
    openapi: "3.0.3",
    info: {},
    paths: {},
    components: {
    	schemas: {},
    	parameters: {},
    	requestBodies: {},
    	responses: {},
    	securitySchemes: {
	    	jwt: {
		      type: "http",
		      bearerFormat: "JWT",
    		  scheme: "bearer",
      		}
    	}
    },
};

function toSwagger(apidocJson, projectJson) {
    swagger.info = addInfo(projectJson);
    swagger.paths = extractPaths(apidocJson, projectJson, swagger);
    return swagger;
}

function addInfo(projectJson) {
    var info = {};
    info["title"] = projectJson.title || projectJson.name;
    info["version"] = projectJson.version;
    info["description"] = projectJson.description;
    if (projectJson.header && projectJson.header.filename) {
        info["description"] = String(fs.readFileSync(projectJson.header.filename))
    }
    return info;
}

function extractPaths(apidocJson, projectJson, swagger) {
	var paths = {};
	let apiPathPrefix = projectJson.url || ''
	let versionMap = {}
	for (var i = 0; i < apidocJson.length; i++) {
		var verb = apidocJson[i];
		if (versionMap[verb.url + verb.type] && verb.version < versionMap[verb.url + verb.type]) {
		continue
		}
		let urlStrip = /((\/[\w:]+)+)/.exec(verb.url)
		var url = urlStrip[1];
		var matchRegex = /(:\w+)\b/ig;
		var pathKeys = {};
		while (matches = matchRegex.exec(url)) {
			for (let j = 1; j < matches.length; j++) {
			    var key = matches[j].substr(1);
			    pathKeys[key] = true;
			    url = url.replace(matches[j], "{" + key + "}");
			}
		}
		try {
			var type = verb.type;
			var obj = paths[apiPathPrefix+url] = paths[apiPathPrefix+url] || {};
			_.extend(obj, generateProps(verb, pathKeys, swagger))
			versionMap[verb.url + verb.type] = verb.version
		} catch (error) {
			console.error(url, type, error);
			continue;
		}
	}
	return paths;
}

function generateProps(verb, pathKeys, swagger) {
    const pathItemObject = {}
    const parameters = generateParameters(verb, pathKeys)
    pathItemObject[verb.type] = {
        tags: [verb.group],
        summary: verb.version + ' ' + removeTags(verb.title),
        description: removeTags(verb.description),
        parameters: parameters.parameters,
        security: generateSecurity(verb),
        responses: generateResponses(verb, swagger.components.responses)
    }
    if (verb.type !== 'get' && verb.type !== 'delete' && parameters.requestBody) {
    pathItemObject[verb.type].requestBody = parameters.requestBody
    }
    return pathItemObject
}

function generateSecurity (verb) {
    let security = []
    for (let example of verb.examples) {
	    if (example.content.includes("Authorization: Bearer")) {
	    	security.push({jwt: []})
    	}
    }
    return security.length ? security : undefined
}

function generateParameters(verb, pathKeys) {
    const mixedQuery = []
    const mixedBody = []
    const parameters = []
    const header = verb && verb.header && verb.header.fields.Header || []
    if (verb && verb.parameter && verb.parameter.fields) {
        const Parameter = verb.parameter.fields.Parameter || []
        mixedQuery.push(...(verb.parameter.fields.Query || []))
        mixedBody.push(...(verb.parameter.fields.Body || []))
        Parameter.forEach(p => {
        	if (pathKeys[p.field]) {
        		parameters.push({
				in: 'path',
				name: p.field,
				description: removeTags(p.description),
				required: !p.optional,
				schema: {type: p.type.toLowerCase()}
			})
			return
        	}
		if (verb.type === 'get' || verb.type === 'delete') {
			mixedQuery.push(p)
		} else {
			mixedBody.push(p)
		}
        })
    }
    parameters.push(...mixedQuery.map(p => {
	    return {
		in: 'query',
		name: p.field,
		description: removeTags(p.description),
		required: !p.optional,
		schema: {type: p.type.toLowerCase()}
	    }
    }))
    parameters.push(...header.map(mapHeaderItem))
    requestBody = generateRequestBody(verb, mixedBody)
    return {parameters, requestBody}
}

function mapHeaderItem(i) {
    return {
        type: 'string',
        in: 'header',
        name: i.field,
        description: removeTags(i.description),
        required: !i.optional,
        default: i.defaultValue
    }
}

var tagsRegex = /(<([^>]+)>)/ig;

function removeTags(text) {
    return text ? text.replace(tagsRegex, "") : text;
}

function generateRequestBody(verb, mixedBody) {
    const bodyParameter = {
    	description: "Request body",
    	content: {"application/json":{
		schema: {
		    properties: {},
		    type: 'object'
		}
        }}
    }
    if (_.get(verb, 'parameter.examples.length') > 0) {
        for (const example of verb.parameter.examples) {
            const { code, json } = safeParseJson(example.content, verb)
            const schema = GenerateSchema.json(example.title, json)
            bodyParameter.content["application/json"].schema = schema
            bodyParameter.description = example.title
        }
    }
    transferApidocParamsToSwaggerBody(mixedBody, bodyParameter.content["application/json"])
    return bodyParameter
}

function generateResponses(verb, responses) {
    const verResponses = {}
    if (verb.success && verb.success.examples && verb.success.examples.length > 0) {
        for (const example of verb.success.examples) {
	        const {code, responseHash} = generateResponseFromExample(example, verb, responses)
            //responses[code] = { content: {"application/json": {schema: schema, example: json}}, description: example.title }
            verResponses[code] = { $ref: "#/components/responses/" + responseHash }
        }

    }
    if (verb.error && verb.error.examples && verb.error.examples.length > 0) {
        for (const example of verb.error.examples) {
	        const {code, responseHash} = generateResponseFromExample(example, verb, responses)
            verResponses[code] = { $ref: "#/components/responses/" + responseHash }
        }

    }
    if (Object.keys(responses).length === 0) {
        verResponses[200] = {description: "ok (default)"}
    }
    // todo: discrepancy with parsed examples schema, which cover more codes
    // mountResponseSpecSchema(verb, responses)
    return verResponses
}

function generateResponseFromExample(example, verb, responses) {
    const { code, json } = safeParseJson(example.content, verb)
    const schema = convertNullTypesToOpenApiNullables(GenerateSchema.json(example.title, json))
    delete schema.$schema
    let responseHash = md5(JSON.stringify(schema))
    responses[responseHash] = { content: {"application/json": {schema, example: json}}, description: example.title }
    return {code, responseHash}
}

function convertNullTypesToOpenApiNullables (schema) {
	if (schema.type === 'object') {
		for (let property in schema.properties) {
			schema.properties[property] = convertNullTypesToOpenApiNullables(schema.properties[property])
		}
		return schema
	}
	if (schema.type === 'null') {
		return { type: 'object', default: null, nullable: true, properties: {} }
	}
	
	for (let property in schema) {
		if (schema[property].type === 'object') {
			schema[property].properties = convertNullTypesToOpenApiNullables(schema[property].properties)
		}
		if (schema[property].type === 'null') {
			schema[property] = { type: 'object', default: null, nullable: true, properties: {} }
		}
	}
	return schema
}

function mountResponseSpecSchema(verb, responses) {
	let success = _.get(verb, 'success.fields.Success 200')
    if (success && !responses[200]) {
        const apidocParams = verb.success['fields']['Success 200']
        responses[200] = transferApidocParamsToSwaggerBody(success, responses[200])
    }
}

function safeParseJson(content, verb) {
    const leftCurlyBraceIndex = content.indexOf('{')
    const mayCodeString = content.slice(0, leftCurlyBraceIndex)
    const mayContentString = content.slice(leftCurlyBraceIndex)
    const mayCodeSplit = mayCodeString.trim().split(' ')
    let match = /HTTP\/.+ (\d+) /.exec(content)
    const code = match[1] ? parseInt(match[1]) : 200
    let json = {}
    try {
        json = JSON.parse(mayContentString)
    } catch (error) {
        console.warn('parse error at', verb.url, verb.type, error, content)
    }
    return {code, json}
}


function createNestedName(field, defaultObjectName) {
    let propertyName = field;
    let objectName;
    let propertyNames = field.split(".");
    if (propertyNames && propertyNames.length > 1) {
        propertyName = propertyNames.pop();
        objectName = propertyNames.join(".");
    }

    return {
        propertyName: propertyName,
        objectName: objectName || defaultObjectName
    }
}

function transferApidocParamsToSwaggerBody(apiDocParams, parameterInBody) {
    let mountPlaces = {
        '': parameterInBody['schema']
    }
    apiDocParams.forEach(i => {
        const type = i.type.toLowerCase()
        const key = i.field
        const nestedName = createNestedName(i.field)
        const { objectName = '', propertyName } = nestedName
	if (mountPlaces[objectName]) {
        if (type.endsWith('object[]')) {
            // if schema(parsed from example) doesn't has this constructure, init
            if (!mountPlaces[objectName]['properties'][propertyName]) {
                mountPlaces[objectName]['properties'][propertyName] = { type: 'array', items: { type: 'object', properties: {} } }
            }
            // new mount point
            mountPlaces[key] = mountPlaces[objectName]['properties'][propertyName]['items']
        } else if (type.endsWith('[]')) {
            // if schema(parsed from example) doesn't has this constructure, init
            if (!mountPlaces[objectName]['properties'][propertyName]) {
                mountPlaces[objectName]['properties'][propertyName] = {
                    items: {
                        type: type.slice(0, -2),
                        description: i.description,
                        // default: i.defaultValue,
                        example: i.defaultValue
                    },
                    type: 'array'
                }
            }
        } else if (type === 'object') {
            // if schema(parsed from example) doesn't has this constructure, init
            if (!mountPlaces[objectName]['properties'][propertyName]) {
                mountPlaces[objectName]['properties'][propertyName] = { type: 'object', properties: {} }
            }
            // new mount point
            mountPlaces[key] = mountPlaces[objectName]['properties'][propertyName]
        } else if (type === 'null') {
            // if schema(parsed from example) doesn't has this constructure, init
            if (!mountPlaces[objectName]['properties'][propertyName]) {
                mountPlaces[objectName]['properties'][propertyName] = { type: 'object', default: null, nullable: true, properties: {} }
            }
            // new mount point
            mountPlaces[key] = mountPlaces[objectName]['properties'][propertyName]
        } else {
        	let property = {
                type,
                description: i.description,
            }
            if (i.allowedValues) {
            	property.enum = type === 'number' ? i.allowedValues.map(v => Number(v)) : i.allowedValues
            }
            if (i.defaultValue) {
            	property.default = type === 'number' ? Number(i.defaultValue) : i.defaultValue
            }
            // todo: min-max length for strings
            // todo: min-max value for numbers
            mountPlaces[objectName]['properties'][propertyName] = property
        }
        if (!i.optional) {
            // generate-schema forget init [required]
            if (mountPlaces[objectName]['required']) {
                mountPlaces[objectName]['required'].push(propertyName)
            } else {
                mountPlaces[objectName]['required'] = [propertyName]
            }
        }
        }
    })
    return parameterInBody
}

module.exports = {
    toSwagger: toSwagger
};
