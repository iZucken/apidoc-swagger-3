var _ = require('lodash');
const { debug, log } = require('winston');
const GenerateSchema = require('generate-schema')

var swagger = {
    openapi: "3.0.3",
    info: {},
    paths: {}
};

function toSwagger(apidocJson, projectJson) {
    swagger.info = addInfo(projectJson);
    swagger.paths = extractPaths(apidocJson);
    return swagger;
}

function addInfo(projectJson) {
    var info = {};
    info["title"] = projectJson.title || projectJson.name;
    info["version"] = projectJson.version;
    info["description"] = projectJson.description;
    return info;
}

function extractPaths(apidocJson) {
	var paths = {};
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
			var obj = paths[url] = paths[url] || {};
			_.extend(obj, generateProps(verb, pathKeys))
			versionMap[verb.url + verb.type] = verb.version
		} catch (error) {
			console.error(url, type, error);
			continue;
		}
	}
	return paths;
}

function generateProps(verb, pathKeys) {
    const pathItemObject = {}
    const parameters = generateParameters(verb, pathKeys)
    const responses = generateResponses(verb)
    pathItemObject[verb.type] = {
        tags: [verb.group],
        summary: removeTags(verb.name) + ' v' + verb.version,
        description: removeTags(verb.title),
        parameters: parameters.parameters,
        responses
    }
    if (verb.type !== 'get' && parameters.requestBody) {
    pathItemObject[verb.type].requestBody = parameters.requestBody
    }
    return pathItemObject
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
		if (verb.type === 'get') {
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

function generateResponses(verb) {
    const success = verb.success
    const responses = {
        200: {
            description: "ok (default)"
        }
    }
    if (success && success.examples && success.examples.length > 0) {
        for (const example of success.examples) {
            const { code, json } = safeParseJson(example.content, verb)
            const schema = GenerateSchema.json(example.title, json)
            delete schema.$schema
            responses[code] = { content: {"application/json": {schema: schema}}, description: example.title }
        }

    }
    mountResponseSpecSchema(verb, responses)
    return responses
}



function mountResponseSpecSchema(verb, responses) {
    // if (verb.success && verb.success['fields'] && verb.success['fields']['Success 200']) {
    if (_.get(verb, 'success.fields.Success 200')) {
        const apidocParams = verb.success['fields']['Success 200']
        responses[200] = transferApidocParamsToSwaggerBody(apidocParams, responses[200])
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
                        type: type.slice(0, -2), description: i.description,
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
        } else {
            mountPlaces[objectName]['properties'][propertyName] = {
                type,
                description: i.description,
                default: i.defaultValue,
            }
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
