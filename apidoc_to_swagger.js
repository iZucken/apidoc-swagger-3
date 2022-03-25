const _ = require('lodash');
const crypto = require('crypto')
const fs = require('fs')
const { debug, log } = require('winston');
const GenerateSchema = require('generate-schema')

const hashObject = object => crypto.createHash('sha1').update(JSON.stringify(object)).digest('hex')

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
    hashNameMap: {},
}

function swaggerComponent(swagger, type, data, name) {
	let hash = hashObject(data)
	if (swagger.hashNameMap[hash]) {
		name = swagger.hashNameMap[hash]
	} else {
		swagger.hashNameMap[hash] = name
	}
	swagger.components[type][name] = data
	return {$ref: `#/components/${type}/${name}`}
}

function toSwagger(apidocJson, projectJson) {
    swagger.info = addInfo(projectJson)
    swagger.paths = extractPaths(apidocJson, projectJson, swagger)
    delete swagger.hashNameMap
    return swagger
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
    const parameters = generateParameters(verb, pathKeys, swagger)
    pathItemObject[verb.type] = {
        tags: [verb.group],
        summary: verb.version + ' ' + removeTags(verb.title),
        description: removeTags(verb.description),
        parameters: parameters.parameters && parameters.parameters.length ? parameters.parameters : undefined,
        security: generateSecurity(verb),
        responses: generateResponses(verb, swagger)
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

const slashMatchRegex = /\//g

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1)
}

function capitalizeJoin(strings) {
  return strings.map(string => capitalizeFirstLetter(string)).join('')
}


const urlSplitMatchRegex = /[\/\:]/g

function atVerb(verb, ...at) {
	return capitalizeJoin([
		...at,
		'at',
		verb.type,
		...verb.url.split('?')[0].split(urlSplitMatchRegex).filter(v => !!v)
	])
}

function generateParameters(verb, pathKeys, swagger) {
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
        		let parameter = {
					in: 'path',
					name: p.field,
					description: removeTags(p.description),
					required: !p.optional,
					schema: {type: p.type.toLowerCase()}
				}
        		parameters.push(swaggerComponent(swagger, 'parameters', parameter, atVerb(verb, 'PathParameter', p.field)))
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
		let parameter = {
			in: 'query',
			name: p.field,
			description: removeTags(p.description),
			required: !p.optional,
			schema: {type: p.type.toLowerCase()}
	    }
		return swaggerComponent(swagger, 'parameters', parameter, atVerb(verb, 'QueryParameter', p.field))
    }))
    parameters.push(...header.map(mapHeaderItem))
    requestBody = generateRequestBody(verb, mixedBody, swagger)
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

function generateRequestBody(verb, mixedBody, swagger) {
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
    transferApidocParamsToSwaggerBody(mixedBody, bodyParameter.content["application/json"], swagger.components.schemas)
//    bodyParameter.content["application/json"].schema = collapseRepeatingSchemas(bodyParameter.content["application/json"].schema, swagger.components.schemas)
    return bodyParameter
}

function generateResponses(verb, swagger) {
    const verbResponses = {}
    if (verb.success && verb.success.examples && verb.success.examples.length > 0) {
        for (const example of verb.success.examples) {
        	generateResponseFromExample(verbResponses, example, verb, swagger)
        }

    }
    if (verb.error && verb.error.examples && verb.error.examples.length > 0) {
        for (const example of verb.error.examples) {
        	generateResponseFromExample(verbResponses, example, verb, swagger)
        }

    }
    if (Object.keys(verbResponses).length === 0) {
        verbResponses[200] = {description: "OK"}
    }
    // todo: discrepancy with parsed examples schema, which cover more codes
    // mountResponseSpecSchema(verb, responses)
    return verbResponses
}

function generateResponseFromExample(responses, example, verb, swagger) {
    const {code, json} = safeParseJson(example.content, verb)
    const schema = convertNullTypesToOpenApiNullables(GenerateSchema.json(example.title, json))
    delete schema.$schema
    let response = {content: {"application/json": {
    	schema: swaggerComponent(swagger, 'schemas', schema, atVerb(verb, "ResponseSchema")),
    	example: json
	}}, description: example.title}
    responses[code] = swaggerComponent(swagger, 'responses', response, atVerb(verb, "Response", String(code)))
}

function convertNullTypesToOpenApiNullables (schema) {
	if (schema.type === 'object') {
		for (let property in schema.properties) {
			schema.properties[property] = convertNullTypesToOpenApiNullables(schema.properties[property])
		}
		return schema
	}
	if (schema.type === 'null') {
		return { type: 'object', default: null, nullable: true }
	}
	
	for (let property in schema) {
		if (schema[property].type === 'object') {
			schema[property].properties = convertNullTypesToOpenApiNullables(schema[property].properties)
		}
		if (schema[property].type === 'null') {
			schema[property] = { type: 'object', default: null, nullable: true }
		}
	}
	return schema
}

function mountResponseSpecSchema(verb, responses, swagger) {
	let success = _.get(verb, 'success.fields.Success 200')
    if (success && !responses[200]) {
        const apidocParams = verb.success['fields']['Success 200']
        responses[200] = transferApidocParamsToSwaggerBody(success, responses[200], swagger.components.schemas)
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

function collapseRepeatingSchemas (schema, schemas) {
	if (schema.type === "array") {
		let hash = hashObject(schema.items)
		schemas[hash] = schema.items
		return {type: "array", items: {$ref: "#/components/schemas/"+hash}}
	}
	//if (schema.type === "object") {
	//	let hash = hashObject(schema)
	//	schemas[hash] = schema
	//	return {$ref: "#/components/schemas/"+hash}
	//} 
	//return schema
}

function transferApidocParamsToSwaggerBody(apiDocParams, parameterInBody, schemas) {
    let mountPlaces = {
        '': parameterInBody.schema
    }
    apiDocParams.forEach(i => {
    const type = i.type.toLowerCase()
    const key = i.field
    const nestedName = createNestedName(i.field)
    const { objectName = '', propertyName } = nestedName
	// todo: avoid if
	if (mountPlaces[objectName]) {
        if (type.endsWith('object[]')) {
            if (!mountPlaces[objectName].properties[propertyName]) {
                mountPlaces[objectName].properties[propertyName] = { type: 'array', items: { type: 'object', properties: {} } }
            }
            mountPlaces[key] = mountPlaces[objectName].properties[propertyName].items
        } else if (type.endsWith('[]')) {
            if (!mountPlaces[objectName].properties[propertyName]) {
                mountPlaces[objectName].properties[propertyName] = {
                    type: 'array',
                    items: {
                        type: type.slice(0, -2),
                        description: i.description,
                        example: i.defaultValue
                    }
                }
            }
        } else if (type === 'object') {
            if (!mountPlaces[objectName].properties[propertyName]) {
                mountPlaces[objectName].properties[propertyName] = { type: 'object', properties: {} }
            }
            mountPlaces[key] = mountPlaces[objectName].properties[propertyName]
        } else if (type === 'null') {
            if (!mountPlaces[objectName].properties[propertyName]) {
                mountPlaces[objectName].properties[propertyName] = { type: 'object', default: null, nullable: true }
            }
            mountPlaces[key] = mountPlaces[objectName].properties[propertyName]
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
            if (i.size) {
            	let sizes = i.size.split("..")
            	if (type === "string") {
		        	property.minLength = sizes[0] ? Number(sizes[0]) : undefined
		        	property.maxLength = sizes[1] ? Number(sizes[1]) : undefined
            	} else if (type === "number") {
		        	property.minimum = sizes[0] ? Number(sizes[0]) : undefined
		        	property.maximum = sizes[1] ? Number(sizes[1]) : undefined
            	}
            }
            mountPlaces[objectName].properties[propertyName] = property
        }
        if (!i.optional) {
            if (mountPlaces[objectName].required) {
                mountPlaces[objectName].required.push(propertyName)
            } else {
                mountPlaces[objectName].required = [propertyName]
            }
        }
    }
    })
    return parameterInBody
}


function createNestedName(field) {
    let propertyName = field;
    let objectName;
    let propertyNames = field.split(".");
    if (propertyNames && propertyNames.length > 1) {
        propertyName = propertyNames.pop();
        objectName = propertyNames.join(".");
    }
    return {propertyName, objectName}
}

module.exports = {
    toSwagger: toSwagger
};
