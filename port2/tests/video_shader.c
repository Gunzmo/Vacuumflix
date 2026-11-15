// Exercise the actual renderer and frame protocol using an offscreen GL context.
#define main viewer_main
#include "../renderer/scene_viewer.c"
#undef main
#include <assert.h>

static void check_frame(const char*path,unsigned seq,int w,int h,int format,int r,int g,int b){
    FILE*f=fopen(path,"wb"); assert(f);
    unsigned hdr[3]={(unsigned)w|(format?0x80000000u:0)|(format==2?0x40000000u:0),(unsigned)h,seq};
    fwrite(hdr,4,3,f);
    if(format){
        for(int i=0;i<w*h;i++) fputc(81,f);
        for(int i=0;i<((w+1)/2)*((h+1)/2);i++) fputc(90,f);
        for(int i=0;i<((w+1)/2)*((h+1)/2);i++) fputc(240,f);
    } else { for(int i=0;i<w*h;i++){ unsigned char px[]={0,0,255,255}; fwrite(px,1,4,f); } }
    fclose(f);
    Widget wd={0}; wd.w=16; wd.h=16; wd.opacity=wd.scale=1;
    wd.nitems=1; wd.items[0]=(char*)path; wd.kinds[0]='M'; wd.ia[0]=1; wd.uv[0][0]=-1;
    glClear(GL_COLOR_BUFFER_BIT); draw(&wd,0,0,1,1,16,16);
    unsigned char px[4]; glReadPixels(8,8,1,1,GL_RGBA,GL_UNSIGNED_BYTE,px);
    if(abs(px[0]-r)>2||abs(px[1]-g)>2||abs(px[2]-b)>2){ fprintf(stderr,"format %d got %d,%d,%d expected %d,%d,%d\n",format,px[0],px[1],px[2],r,g,b); abort(); }
    assert(glGetError()==GL_NO_ERROR);
    GLint yuv=-1; glGetUniformiv(tprog,uTYUV,&yuv); assert(yuv==0);
}
int main(void){
    assert(SDL_Init(SDL_INIT_VIDEO)==0);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK,SDL_GL_CONTEXT_PROFILE_ES);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION,3);
    SDL_Window*win=SDL_CreateWindow("shader test",0,0,16,16,SDL_WINDOW_OPENGL|SDL_WINDOW_HIDDEN); assert(win);
    SDL_GLContext ctx=SDL_GL_CreateContext(win); assert(ctx); gl_init();
    GLint ok=0; glGetProgramiv(tprog,GL_LINK_STATUS,&ok); assert(ok);
    glViewport(0,0,16,16); g_dw=g_dh=16;
    char path[]="/tmp/vacuumflix-shader-XXXXXX"; int fd=mkstemp(path); assert(fd>=0); close(fd);
    check_frame(path,1,4,4,1,254,0,0);
    check_frame(path,2,4,4,2,255,24,0); // update existing plane storage
    check_frame(path,3,3,3,1,254,0,0); // resize and odd chroma dimensions
    check_frame(path,4,3,3,0,0,0,255); // legacy RGBA, including format transition
    check_frame(path,5,4,4,2,255,24,0); // RGBA back to planar
    printf("video shader checks passed (%s)\n",glGetString(GL_RENDERER));
    unlink(path); SDL_GL_DeleteContext(ctx); SDL_DestroyWindow(win); SDL_Quit(); return 0;
}
