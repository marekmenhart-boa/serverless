'use strict';

/**
 * Action: Endpoint Deploy ApiGateway
 * - Creates a new API Gateway Deployment
 * - Handles one region only.  The FunctionDeploy Action processes multiple regions by calling this multiple times.
 */

module.exports = function(SPlugin, serverlessPath) {
    const path     = require('path'),
        SError     = require(path.join(serverlessPath, 'Error')),
        BbPromise  = require('bluebird'),
        fs         = require('fs');
    let SUtils;

    // Promisify fs module
    BbPromise.promisifyAll(fs);

    class EndpointDeployApiGateway extends SPlugin {

        constructor(S, config) {
            super(S, config);
            SUtils = S.utils;
        }

        static getName() {
            return 'serverless.core.' + EndpointDeployApiGateway.name;
        }

        registerActions() {
            this.S.addAction(this.endpointDeployApiGateway.bind(this), {
                handler:     'endpointDeployApiGateway',
                description: 'Creates an API Gateway deployment in a region'
            });
            return Promise.resolve();
        }

        /**
         * Handler
         */

        endpointDeployApiGateway(evt) {

            let _this              = this;
            _this.evt              = evt;
            _this.project          = _this.S.getProject();
            _this.provider         = _this.S.getProvider();
            _this.awsAccountNumber = _this.project.getRegion(_this.evt.options.stage, _this.evt.options.region).getVariables().iamRoleArnLambda.replace('arn:aws:iam::', '').split(':')[0];

            return _this._validateAndPrepare()
                .bind(_this)
                .then(_this._createAuthorizers)
                .then(_this._createDeployment)
                .then(function() {

                    /**
                     * Return EVT
                     */

                    _this.evt.data.deploymentId = _this.deployment.id;
                    return _this.evt;

                });
        }

        /**
         * Validate And Prepare
         */

        _validateAndPrepare() {
            return BbPromise.resolve();
        }

        /**
         * Create Authorizers
         */

        _createAuthorizers() {

            let _this = this;
            let functions = _this.project.getAllFunctions();

            return BbPromise.try(function() {

                    // Otherwise, delete pre-existing on authorizers deployed on API Gateway
                    let params = {
                        restApiId: _this.evt.options.restApiId,
                        limit: 100
                    };

                    return _this.provider.request('APIGateway', 'getAuthorizers', params, _this.evt.options.stage, _this.evt.options.region)
                        .then(function(a) {
                            return a.items;
                        });
                })
                .each(function(a) {

                    // Otherwise, delete pre-existing on authorizers deployed on API Gateway
                    let params = {
                        restApiId: _this.evt.options.restApiId,
                        authorizerId: a.id
                    };

                    return _this.provider.request('APIGateway', 'deleteAuthorizer', params, _this.evt.options.stage, _this.evt.options.region);

                })
                .then(function() {
                    return functions;
                })
                .each(function(f) {

                    // If no authorizer data, skip
                    if (!f.authorizer || !Object.keys(f.authorizer).length) return;

                    f = f.toObjectPopulated({ stage: _this.evt.options.stage, region: _this.evt.options.region });

                    // Create new authorizer on API Gateway

                    // Fetch Lambda
                    let params = {
                        FunctionName: f.customName || f.name,
                        Qualifier: _this.evt.options.stage
                    };

                    return _this.provider.request('Lambda', 'getFunction', params, _this.evt.options.stage, _this.evt.options.region)
                        .then(function(l) {
                            // Validate required authorizer params
                            if (!f.authorizer.identitySource) throw new SError(`Authorizer is missing identitySource property in function ${f.name}`);

                            // Create Authorizer params.  Set defaults.
                            let authorizer           = f.authorizer;
                            authorizer.restApiId     = _this.evt.options.restApiId;
                            authorizer.name          = authorizer.name || f.customName;
                            authorizer.type          = authorizer.type || 'TOKEN';

                            // Construct authorizer URI
                            authorizer.authorizerUri = 'arn:aws:apigateway:'
                                + _this.evt.options.region
                                + ':lambda:path/2015-03-31/functions/arn:aws:lambda:'
                                + _this.evt.options.region
                                + ':'
                                + _this.awsAccountNumber
                                + ':function:'
                                + (f.customName || f.name)
                                + ':'
                                + _this.evt.options.stage
                                + '/invocations';

                            return _this.provider.request('APIGateway', 'createAuthorizer', authorizer, _this.evt.options.stage, _this.evt.options.region);
                        });
                });
        }

        /**
         * Create Deployment
         */

        _createDeployment() {

            let _this = this;

            return new BbPromise( function( resolve, reject ){

                let doDeploy = function() {

                    let params = {
                        restApiId:        _this.evt.options.restApiId, /* required */
                        stageName:        _this.evt.options.stage, /* required */
                        //cacheClusterEnabled:  false, TODO: Implement
                        //cacheClusterSize: '0.5 | 1.6 | 6.1 | 13.5 | 28.4 | 58.2 | 118 | 237', TODO: Implement
                        description:      _this.evt.options.description || 'Serverless deployment',
                        stageDescription: _this.evt.options.stage,
                        variables: {
                            functionAlias:  _this.evt.options.stage
                        }
                    };

                    _this.provider.request('APIGateway', 'createDeployment', params, _this.evt.options.stage, _this.evt.options.region)
                        .then(function(response) {

                            _this.deployment = response;

                            SUtils.sDebug(
                                '"'
                                + _this.evt.options.stage
                                + ' - '
                                + _this.evt.options.region
                                + ' - REST API: '
                                + 'created API Gateway deployment: '
                                + response.id);

                            return resolve();
                        })
                        .catch(function(error) {
                            if( error.statusCode == 429 ) {
                                SUtils.sDebug("'Too many requests' received, sleeping 60 seconds");
                                setTimeout( doDeploy, 60000 );
                            } else
                                reject( new SError(error.message) );
                        });
                };

                return doDeploy();
            });
        }
    }

    return( EndpointDeployApiGateway );
};
