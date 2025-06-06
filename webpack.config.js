/**
 * Webpack Configuration for Production Build Optimization
 */

const path = require('path')
const webpack = require('webpack')

module.exports = (env, argv) => {
  const isProduction = argv.mode === 'production'

  return {
    target: 'node',
    mode: isProduction ? 'production' : 'development',
    entry: './src/main.js',

    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'index.js',
      clean: true,
    },

    optimization: {
      minimize: isProduction,
      usedExports: true,
      sideEffects: false,
    },

    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: [
                [
                  '@babel/preset-env',
                  {
                    targets: { node: '20' },
                    modules: false,
                  },
                ],
              ],
            },
          },
        },
      ],
    },

    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },

    externals: {
      // Keep GitHub Actions core modules external
      '@actions/core': '@actions/core',
      '@actions/github': '@actions/github',
    },

    plugins: [
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify(
          isProduction ? 'production' : 'development'
        ),
      }),

      // Bundle analyzer for production builds
      ...(isProduction && env && env.analyze
        ? [new (require('webpack-bundle-analyzer').BundleAnalyzerPlugin)()]
        : []),
    ],

    devtool: isProduction ? 'source-map' : 'inline-source-map',

    stats: {
      colors: true,
      modules: false,
      children: false,
      chunks: false,
      chunkModules: false,
    },
  }
}
