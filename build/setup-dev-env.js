var path = require('path')
var vm = require('vm')
var webpack = require('webpack')
var webpackDevMiddleware = require('webpack-dev-middleware')
var MFS = require('memory-fs')
var clientConfig = require('./webpack.config')
var serverConfig = require('./webpack.config.server')

exports.setupClient = function setupClient() {
	var clientDevMiddleware = webpackDevMiddleware(webpack(clientConfig), {
		publicPath: `/static/javascript/`,
		stats: {
			colors: true,
			chunks: false,
		},
		serverSideRender: true,
	})
	return clientDevMiddleware
}

exports.setupServer = function setupServer(options) {
	var serverCompiler = webpack(serverConfig)
	var mfs = new MFS()
	var outputPath = path.join(serverConfig.output.path, serverConfig.output.filename)
	serverCompiler.outputFileSystem = mfs
	serverCompiler.watch({}, (err, stats) => {
		if (err) throw err
		stats = stats.toJson()
		stats.errors.forEach(err => console.error(err))
		stats.warnings.forEach(err => console.warn(err))
		var sourceCode = mfs.readFileSync(outputPath, 'utf-8')

		// 构造一个 commonjs 的模块加载函数，拿到 newModule
		var newModule = vm.runInThisContext(`
			(function(require) {
				var module = {exports: {}}
                var factory = function(require, module, exports) {
                    ${sourceCode}
                }
                try {
                    factory(require, module, module.exports)
                } catch(error) {
                    console.log(error)
                    return null
                }
                return module.exports
			})
		`)(require)

		if (newModule) {
			options.handleHotModule(newModule.default ||  newModule)
		}
	})
}