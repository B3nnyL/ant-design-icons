'use strict';
import fs = require('fs-extra');
import _ = require('lodash');
import parse5 = require('parse5');
import path = require('path');
import Prettier = require('prettier');
import { from, Observable } from 'rxjs';
import { concat, filter, map, mergeMap, reduce } from 'rxjs/operators';
import SVGO = require('svgo');
import {
  EXPORT_DEFAULT_COMPONENT_FROM_DIR,
  EXPORT_DEFAULT_MANIFEST,
  ICON_GETTER_FUNCTION,
  ICON_IDENTIFIER,
  ICON_JSON,
  TWO_TONE_NAME,
  TWO_TONE_THEME
} from './constants';
import {
  BuildTimeIconMetaData,
  Environment,
  IconDefinition,
  Manifest,
  NameAndPath,
  Node,
  ThemeType,
  WriteFileMetaData
} from './typings';
import {
  clear,
  generateAbstractTree,
  getIdentifier,
  isAccessable,
  log,
  withSuffix
} from './utils';
import { normalize } from './utils/normalizeNames';

/**
 * Process and minimize the svg files from the /svg directory.
 * Generate the JSON data to the /src directory.
 * @param env build environment variables
 */
export async function build(env: Environment) {
  const svgo = new SVGO(env.options.svgo);

  // Single theme means that dont need the property 'fill' in the path element.
  const singleType: ThemeType[] = ['fill', 'outline'];
  const svgoForSingleIcon = new SVGO({
    ...env.options.svgo,
    plugins: [
      ...env.options.svgo.plugins!,
      // single color should remove the `fill` attribute.
      { removeAttrs: { attrs: ['fill'] } }
    ]
  });

  // remove and delete all old output files.
  await clear(env);

  // rename all the svg files' names.
  const svgBasicNames = await normalize(env);

  // SVG Meta Data Flow
  const svgMetaDataWithTheme$ = from<ThemeType>([
    'fill',
    'outline',
    'twotone'
  ]).pipe(
    map<ThemeType, Observable<BuildTimeIconMetaData>>((theme) =>
      from(svgBasicNames).pipe(
        map<string, NameAndPath>((kebabCaseName) => {
          const identifier = getIdentifier(
            _.upperFirst(_.camelCase(kebabCaseName)),
            theme
          );
          return { kebabCaseName, identifier };
        }),
        filter(({ kebabCaseName }) =>
          isAccessable(
            path.resolve(env.paths.SVG_DIR, theme, `${kebabCaseName}.svg`)
          )
        ),
        mergeMap<NameAndPath, BuildTimeIconMetaData>(
          async ({ kebabCaseName, identifier }) => {
            const tryUrl = path.resolve(
              env.paths.SVG_DIR,
              theme,
              `${kebabCaseName}.svg`
            );
            let optimizer = svgo;
            if (singleType.includes(theme)) {
              optimizer = svgoForSingleIcon;
            }
            const { data } = await optimizer.optimize(
              await fs.readFile(tryUrl, 'utf8')
            );
            const icon: IconDefinition = {
              name: kebabCaseName,
              theme,
              ...generateAbstractTree(
                (parse5.parseFragment(data) as any).childNodes[0] as Node,
                kebabCaseName
              )
            };
            return { identifier, icon };
          }
        )
      )
    )
  );

  // Icon files content flow.
  const iconTsTemplate = await fs.readFile(env.paths.ICON_TEMPLATE, 'utf8');
  const twoToneIconTsTemplate = await fs.readFile(
    env.paths.TWO_TONE_ICON_TEMPLATE,
    'utf8'
  );
  const iconFiles$ = svgMetaDataWithTheme$.pipe(
    mergeMap<Observable<BuildTimeIconMetaData>, BuildTimeIconMetaData>(
      (metaData$) => metaData$
    ),
    map<
      BuildTimeIconMetaData,
      { identifier: string; content: string; theme: ThemeType }
    >(({ identifier, icon }) => {
      // In some twotone icons, the designer didn't set the primary color path fill.
      if (icon.theme === 'twotone') {
        icon = _.cloneDeep(icon);
        icon.children.forEach((pathElment) => {
          pathElment.attrs.fill = pathElment.attrs.fill || '#333';
        });
      }
      return {
        identifier,
        theme: icon.theme,
        content:
          icon.theme === 'twotone'
            ? Prettier.format(
                twoToneIconTsTemplate
                  .replace(ICON_IDENTIFIER, identifier)
                  .replace(
                    ICON_GETTER_FUNCTION,
                    `function (primaryColor: string, secondaryColor: string) { return ${JSON.stringify(
                      icon
                    )
                      .replace(/"#333"/g, 'primaryColor')
                      .replace(/"#E6E6E6"/g, 'secondaryColor')
                      .replace(/"#D9D9D9"/g, 'secondaryColor')
                      .replace(/"#D8D8D8"/g, 'secondaryColor')}; }`
                  )
                  .replace(TWO_TONE_NAME, icon.name)
                  .replace(TWO_TONE_THEME, icon.theme),
                { ...env.options.prettier, parser: 'typescript' }
              )
            : Prettier.format(
                iconTsTemplate
                  .replace(ICON_IDENTIFIER, identifier)
                  .replace(ICON_JSON, JSON.stringify(icon)),
                env.options.prettier
              )
      };
    }),
    map<
      { identifier: string; content: string; theme: ThemeType },
      WriteFileMetaData
    >(({ identifier, content, theme }) => ({
      path: path.resolve(
        env.paths.ICON_OUTPUT_DIR,
        theme,
        `./${identifier}.ts`
      ),
      content
    }))
  );

  // Index File content flow
  const indexTsTemplate = await fs.readFile(env.paths.INDEX_TEMPLATE, 'utf8');
  const indexFile$ = svgMetaDataWithTheme$.pipe(
    mergeMap<Observable<BuildTimeIconMetaData>, BuildTimeIconMetaData>(
      (metaData$) => metaData$
    ),
    reduce<BuildTimeIconMetaData, string>(
      (acc, { identifier, icon }) =>
        acc +
        `export { default as ${identifier} } from './${
          icon.theme
        }/${identifier}';\n`,
      ''
    ),
    map<string, WriteFileMetaData>((content) => ({
      path: env.paths.INDEX_OUTPUT,
      content: Prettier.format(
        indexTsTemplate.replace(EXPORT_DEFAULT_COMPONENT_FROM_DIR, content),
        env.options.prettier
      )
    }))
  );

  // Manifest File content flow
  const manifestTsTemplate = await fs.readFile(
    env.paths.MANIFEST_TEMPLATE,
    'utf8'
  );
  const manifestFile$ = from<ThemeType>(['fill', 'outline', 'twotone']).pipe(
    map<ThemeType, { theme: ThemeType; names: string[] }>((theme) => ({
      theme,
      names: svgBasicNames.filter((name) =>
        isAccessable(path.resolve(env.paths.SVG_DIR, theme, `${name}.svg`))
      )
    })),
    reduce<{ theme: ThemeType; names: string[] }, Manifest>(
      (acc, { theme, names }) => {
        acc[theme] = names;
        return acc;
      },
      { fill: [], outline: [], twotone: [] }
    ),
    map<Manifest, WriteFileMetaData>((names) => ({
      path: env.paths.MANIFEST_OUTPUT,
      content: Prettier.format(
        manifestTsTemplate.replace(
          EXPORT_DEFAULT_MANIFEST,
          `export default ${JSON.stringify(names)};`
        ),
        env.options.prettier
      )
    }))
  );

  const files$ = iconFiles$.pipe(
    concat(manifestFile$),
    concat(indexFile$)
  );

  return new Promise<void>((resolve, reject) => {
    files$
      .pipe(
        mergeMap(async ({ path: writeFilePath, content }) => {
          await fs.writeFile(writeFilePath, content, 'utf8');
          log.info(`Generated ./${path.relative(env.base, writeFilePath)}.`);
        })
      )
      .subscribe(undefined, reject, () => {
        log.notice('Done.');
        resolve();
      });
  });
}
